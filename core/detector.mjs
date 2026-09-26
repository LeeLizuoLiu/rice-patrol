// Same two-window predicate and warning persistence as the isolated WorkBuddy prototype.
export class ShortLineDetector {
  constructor({ windowLines = 50, maxMedian = 20, minRepeat = 0.7, maxPendingLineChars = 65536 } = {}) {
    this.windowLines = windowLines;
    this.maxMedian = maxMedian;
    this.minRepeat = minRepeat;
    this.maxPendingLineChars = maxPendingLineChars;
    this.current = '';
    this.lines = [];
    this.lineCount = 0;
    this.deltaCount = 0;
    this.offsetUtf16 = 0;
    this.firstHit = null;
    this.confirmedHit = null;
    this.resourceExceeded = false;
  }
  feed(piece) {
    if (typeof piece !== 'string') return null;
    this.deltaCount++;
    let warning = null;
    for (let i = 0; i < piece.length; i++) {
      const ch = piece[i];
      this.offsetUtf16++;
      if (ch !== '\n') {
        if (this.current.length >= this.maxPendingLineChars) {
          this.resourceExceeded = true;
          return { status: 'RESOURCE_LIMIT', offsetUtf16: this.offsetUtf16 };
        }
        this.current += ch;
        continue;
      }
      const line = this.current.trim();
      this.current = '';
      if (!line) continue;
      this.lineCount++;
      this.lines.push(line);
      if (this.lines.length > this.windowLines) this.lines.shift();
      if (this.lines.length < this.windowLines || this.confirmedHit) continue;
      const lengths = this.lines.map(x => x.length).sort((a, b) => a - b);
      const mid = this.windowLines / 2;
      const median = this.windowLines % 2 ? lengths[Math.floor(mid)] : (lengths[mid - 1] + lengths[mid]) / 2;
      const counts = new Map();
      for (const x of this.lines) counts.set(x, (counts.get(x) ?? 0) + 1);
      const repeat = [...counts.values()].filter(n => n > 1).reduce((a, n) => a + n, 0) / this.windowLines;
      if (median <= this.maxMedian && repeat >= this.minRepeat) {
        const hit = { lineCount: this.lineCount, offsetUtf16: this.offsetUtf16,
          deltaCount: this.deltaCount, medianLineLength: median, duplicateShare: repeat };
        if (this.firstHit === null) { this.firstHit = hit; warning = { status: 'WARNING', hit }; }
        if (this.lineCount >= this.firstHit.lineCount + this.windowLines) {
          this.confirmedHit = hit;
          return { status: 'CONFIRMED', firstHit: this.firstHit, confirmedHit: hit };
        }
      }
    }
    return warning;
  }
  // The oracle does not count an unterminated final line. Preserve that rule.
  end() { return { status: this.confirmedHit ? 'CONFIRMED' : this.firstHit ? 'WARNING' : 'NORMAL', pendingLineChars: this.current.length }; }
}
