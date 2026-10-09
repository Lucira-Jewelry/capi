/**
 * Runs one job at a time, in the order they arrive. Used so that an instance never has two dispatch runs going at once
 * (the scheduler and the console's "Send waiting sales now" button can fire together): that is what makes "at most one
 * send in flight per instance" true. A job that fails does not block the ones after it.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
