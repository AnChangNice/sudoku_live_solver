// 同一道题多次重读之间的时序稳定。
//
// 现场读数字本来就会在相邻两次之间翻转：光照变一点、格子平移一两像素，
// 同一个 4 就可能这次读成 4、下次读成 2。如果每次重读都直接替换盘面，
// 答案和待确认框就会不停跳。这里做两道迟滞：
// 1) 和已确认值不同的读数，要连续两次读到同一个值才被采纳；
// 2) 这次没认出来（unknown）不当作空格，沿用已确认的数字。
// 空格第一次读出高置信数字时直接采纳，不用等第二次。

export class ReadStabilizer {
  constructor() {
    this.reset();
  }

  reset() {
    // 已确认的盘面；null 表示还没有基线（第一份读数直接采纳）。
    this.grid = null;
    this.pending = new Array(81).fill(null);
  }

  /**
   * @param {Uint8Array} raw 本次读数的盘面（0 表示空）
   * @param {Array<{kind:string,score?:number,margin?:number}>} details 逐格识别结果
   * @returns {{grid:Uint8Array, unknown:Uint8Array}}
   */
  apply(raw, details) {
    const unknown = new Uint8Array(81);

    if (!this.grid) {
      this.grid = Uint8Array.from(raw);
      for (let i = 0; i < 81; i++) {
        this.pending[i] = null;
        if (details[i].kind === 'unknown') unknown[i] = 1;
      }
      return { grid: this.grid, unknown };
    }

    const grid = Uint8Array.from(this.grid);
    for (let i = 0; i < 81; i++) {
      const detail = details[i];
      if (detail.kind === 'unknown') {
        // 没认出：保留上次的稳定值；上次也是空的才提示待确认。
        if (!grid[i]) unknown[i] = 1;
        continue;
      }

      const next = raw[i];
      if (next === grid[i]) {
        this.pending[i] = null;
        continue;
      }

      // 空 → 数字：高置信读数直接采纳，否则空格里的线索要等两次重读。
      const confident =
        detail.kind === 'digit' &&
        (detail.score || 0) >= 0.8 &&
        (detail.margin || 0) >= 0.2;
      if (!grid[i] && confident) {
        grid[i] = next;
        this.pending[i] = null;
        continue;
      }

      const pending = this.pending[i];
      if (pending && pending.value === next) {
        pending.count++;
        if (pending.count >= 2) {
          grid[i] = next;
          this.pending[i] = null;
        }
      } else {
        this.pending[i] = { value: next, count: 1 };
      }
    }

    this.grid = grid;
    return { grid, unknown };
  }
}
