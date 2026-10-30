// One line per step: a live counter on a terminal, a line per 10% in a log.

const tty = process.stdout.isTTY;
const fmt = (n: number) => n.toLocaleString('en-US');

export class Progress {
  private readonly label: string;
  private readonly total: number;
  private done = 0;
  private lastPercent = -1;
  private readonly started = Date.now();

  constructor(label: string, total: number) {
    this.label = label.padEnd(10);
    this.total = total;
    this.draw();
  }

  tick(count = 1) {
    this.done += count;
    this.draw();
  }

  private draw() {
    const percent = this.total ? Math.floor((this.done / this.total) * 100) : 100;
    const line = `${this.label} ${fmt(this.done)} / ${fmt(this.total)}  ${percent}%`;
    if (tty) process.stdout.write(`\r${line}`);
    else if (percent >= this.lastPercent + 10 || this.done === this.total) {
      this.lastPercent = percent;
      console.log(line);
    }
  }

  finish() {
    const seconds = ((Date.now() - this.started) / 1000).toFixed(1);
    if (tty) process.stdout.write(`\r${this.label} ${fmt(this.done)} / ${fmt(this.total)}  done in ${seconds}s\n`);
    else console.log(`${this.label} done in ${seconds}s`);
  }
}
