/** One terminal line per stage; redirected logs are throttled instead of containing control sequences. */
export class Progress {
	private readonly label: string;
	private readonly started = Date.now();
	private lastPrint = 0;
	private current = "准备中";
	private readonly timer: ReturnType<typeof setInterval>;

	constructor(label: string) {
		this.label = label;
		console.info(`[${label}] 开始`);
		// Keep long HTTP requests visibly alive even before a batch has completed.
		this.timer = setInterval(() => this.update(this.current), 1000);
		this.timer.unref();
	}

	update(message: string): void {
		this.current = message;
		const now = Date.now();
		if (now - this.lastPrint < (process.stdout.isTTY ? 100 : 10_000)) return;
		const line = `[${this.label}] ${message}；耗时 ${((now - this.started) / 1000).toFixed(1)}s`;
		if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
		else console.info(line);
		this.lastPrint = now;
	}

	/** Always finish in finally so failures cannot leave a timer or an unfinished terminal line. */
	finish(message: string): void {
		clearInterval(this.timer);
		if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
		console.info(`[${this.label}] ${message}；耗时 ${((Date.now() - this.started) / 1000).toFixed(1)}s`);
	}
}
