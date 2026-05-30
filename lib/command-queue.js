class CommandQueue {
  constructor() {
    this.running = false;
    this.queue = [];
    this.stopped = false;
  }

  get isBusy() {
    return this.running || this.queue.length > 0;
  }

  stop() {
    this.stopped = true;
    this.queue = [];
  }

  enqueue(task) {
    if (this.stopped) {
      return Promise.reject(new Error('Command queue stopped'));
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;

    this.running = true;
    try {
      const result = await next.task();
      next.resolve(result);
    } catch (error) {
      next.reject(error);
    } finally {
      this.running = false;
      setImmediate(() => this.process());
    }
  }
}

module.exports = CommandQueue;
