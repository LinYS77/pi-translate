import type { Usage } from "@earendil-works/pi-ai";

/** One operation owns all deadlines, in-flight requests and conservative token reservations. */
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
    private readonly tokens = 131072,
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

  record(usage?: Usage) {
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

  async request<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    tokenReservation: number,
    timeoutMs?: number,
  ): Promise<T> {
    this.signal.throwIfAborted();
    if (this.calls >= 64 || this.reserved + tokenReservation > this.tokens)
      throw new Error("翻译请求预算已用尽，剩余内容未处理");
    this.calls++;
    this.reserved += tokenReservation;
    const child = new AbortController();
    const abort = () => child.abort(this.signal.reason);
    this.signal.addEventListener("abort", abort, { once: true });
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => child.abort(new Error("Jev 判断超时")), timeoutMs);
    let listener = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(child.signal.reason);
        child.signal.addEventListener("abort", listener, { once: true });
      });
      const result = await Promise.race([operation(child.signal), cancelled]);
      child.signal.throwIfAborted();
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
