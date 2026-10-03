import type { Usage } from "@earendil-works/pi-ai";

const MAX_REQUESTS = 2048;

interface RequestEstimate<T> {
  inputTokens: number;
  maxOutputTokens: number;
  outputTokens(result: T): number;
  timeoutMs?: number;
}

/** One operation owns deadlines and usage: reserve in flight, then settle completed calls. */
export class RequestBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private calls = 0;
  private reserved = 0;
  usage?: Usage;
  readonly signal: AbortSignal;
  readonly deadlineError: Error;
  private readonly abort: () => void;

  constructor(
    timeoutMs: number,
    private readonly parent?: AbortSignal,
    private readonly tokens = 4_194_304,
  ) {
    this.deadlineError = new Error(`翻译超时（${timeoutMs}ms）`);
    this.signal = this.controller.signal;
    this.abort = () =>
      this.controller.abort(parent?.reason ?? new Error("翻译已取消"));
    parent?.throwIfAborted();
    parent?.addEventListener("abort", this.abort, { once: true });
    this.timer = setTimeout(
      () => this.controller.abort(this.deadlineError),
      timeoutMs,
    );
  }

  private record(usage?: Usage) {
    if (!usage) return;
    if (!this.usage) {
      this.usage = { ...usage, cost: { ...usage.cost } };
      return;
    }
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
    ] as const)
      this.usage[key] += usage[key];
    for (const key of ["reasoning", "cacheWrite1h"] as const) {
      if (usage[key] !== undefined)
        this.usage[key] = (this.usage[key] ?? 0) + usage[key];
    }
    for (const key of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ] as const)
      this.usage.cost[key] += usage.cost[key];
  }

  async request<T extends { usage?: Usage }>(
    operation: (signal: AbortSignal) => Promise<T>,
    estimate: RequestEstimate<T>,
  ): Promise<T> {
    this.signal.throwIfAborted();
    const tokenReservation = estimate.inputTokens + estimate.maxOutputTokens;
    if (this.calls >= MAX_REQUESTS)
      throw new Error(
        `翻译请求预算已用尽（请求次数上限：${MAX_REQUESTS}），剩余内容未处理`,
      );
    if (this.reserved + tokenReservation > this.tokens)
      throw new Error(
        `翻译请求预算已用尽（累计 token 预算上限：${this.tokens}），剩余内容未处理`,
      );
    this.calls++;
    this.reserved += tokenReservation;
    const child = new AbortController();
    const abort = () => child.abort(this.signal.reason);
    this.signal.addEventListener("abort", abort, { once: true });
    const timer =
      estimate.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => child.abort(new Error("Jev 判断超时")),
            estimate.timeoutMs,
          );
    let listener = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(child.signal.reason);
        child.signal.addEventListener("abort", listener, { once: true });
      });
      const result = await Promise.race([operation(child.signal), cancelled]);
      child.signal.throwIfAborted();
      const reported = result.usage?.totalTokens;
      const consumed =
        typeof reported === "number" &&
        Number.isFinite(reported) &&
        reported > 0
          ? reported
          : estimate.inputTokens + estimate.outputTokens(result);
      // Missing/zero usage is not free. Estimate completed input + output, not the
      // unused maxTokens allowance. Failed or unresponsive requests keep their reservation.
      this.reserved += Math.max(0, consumed) - tokenReservation;
      this.record(result.usage);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      this.signal.removeEventListener("abort", abort);
      child.signal.removeEventListener("abort", listener);
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.abort);
  }
}
