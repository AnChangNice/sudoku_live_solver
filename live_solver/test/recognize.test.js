import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createRecognizer,
  classify,
  mergeConsensus,
  SENSITIVITY,
} from '../src/vision/recognize.js';

// 由 `npm run train:digits` 生成的固定样本：每类 2 条，来自独立评测集，
// 模型没参与训练。它们用来防止“权重没更新 / base64 解码错 / 前向算错”这类回归。
const fixture = JSON.parse(
  fs.readFileSync(
    new URL('./fixtures/digit-vectors.json', import.meta.url),
    'utf8',
  ),
);

function decode(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

test('分类器权重可加载，维度正确', async () => {
  const { model } = await createRecognizer();
  assert.equal(model.input, 28 * 28);
  assert.ok(model.hidden >= 24);
  assert.equal(model.w1.length, model.input * model.hidden);
  assert.equal(model.b1.length, model.hidden);
  assert.equal(model.w2.length, model.hidden * 10);
  assert.equal(model.b2.length, 10);
});

test('固定字形样本分类正确，非数字不会被当成线索', async () => {
  const { model } = await createRecognizer();
  const vecs = decode(fixture.vectors);
  const count = fixture.labels.length;
  assert.equal(vecs.length, count * fixture.input);

  const failures = [];
  let digits = 0;
  let accepted = 0;
  for (let i = 0; i < count; i++) {
    const vec = vecs.subarray(i * fixture.input, (i + 1) * fixture.input);
    const truth = fixture.labels[i];
    const c = classify(vec, model, SENSITIVITY.medium);
    if (truth === 0) {
      // 非数字样本绝不能以“确定线索”的身份通过。
      if (c.ok) {
        failures.push({ i, truth: 0, got: c.digit, p: +c.score.toFixed(3) });
      }
      continue;
    }
    digits++;
    if (c.ok) accepted++;
    // argmax 必须是真值；低于阈值只会变成“待确认”，不会读错。
    if (c.digit !== truth) {
      failures.push({
        i,
        truth,
        got: c.digit,
        ok: c.ok,
        p: +c.score.toFixed(3),
        margin: +c.margin.toFixed(3),
      });
    }
  }
  assert.deepEqual(failures, []);
  // 标准阈值下绝大多数样本应直接成为确定数字（剩下一两个允许是待确认）。
  assert.ok(
    accepted / digits >= 0.9,
    `接受率 ${accepted}/${digits} 过低，检查 SENSITIVITY`,
  );
});

test('junk（有墨但不是数字）不会被当成待确认，也不挡另一侧的数字', () => {
  const blank = {
    kind: 'blank', value: 0, guess: 0, score: 0, margin: 0, confidence: 1,
  };
  const junk = {
    kind: 'junk', value: 0, guess: 0, score: 0, margin: 0, confidence: 0,
  };
  const digit = (v, score = 0.98, margin = 0.9) => ({
    kind: 'digit', value: v, guess: v, score, margin, confidence: score,
  });

  const a = new Array(81).fill(blank);
  const b = new Array(81).fill(blank);
  a[0] = junk;
  b[0] = junk; // 两侧都只看到噪点/阴影 → 空格，不打扰用户
  a[1] = junk;
  b[1] = digit(7); // 一侧被格线切坏，另一侧读得很确定 → 采用
  a[2] = junk;
  b[2] = digit(7, 0.7, 0.5); // 不够强 → 待确认

  const m = mergeConsensus(a, b);
  assert.equal(m[0].kind, 'blank');
  assert.equal(m[1].kind, 'digit');
  assert.equal(m[1].value, 7);
  assert.equal(m[2].kind, 'unknown');
});

test('双读共识：一致才保留，未知格保留猜测值', () => {
  const blank = {
    kind: 'blank',
    value: 0,
    guess: 0,
    score: 0,
    margin: 0,
    confidence: 1,
  };
  const digit = (v, score = 0.98, margin = 0.9) => ({
    kind: 'digit',
    value: v,
    guess: v,
    score,
    margin,
    confidence: score,
  });
  const unknown = (guess = 0, score = 0.4, margin = 0.05) => ({
    kind: 'unknown',
    value: 0,
    guess,
    score,
    margin,
    confidence: score,
  });

  const a = new Array(81).fill(blank);
  const b = new Array(81).fill(blank);
  a[0] = digit(5);
  b[0] = digit(5);
  a[1] = digit(5);
  b[1] = digit(6);
  a[2] = digit(7);
  b[2] = unknown();
  a[3] = unknown(4);
  b[3] = unknown(4);
  a[4] = digit(3);
  b[4] = blank;

  const m = mergeConsensus(a, b);
  assert.equal(m[0].kind, 'digit');
  assert.equal(m[0].value, 5);
  assert.equal(m[1].kind, 'unknown');
  assert.equal(m[2].kind, 'digit');
  assert.equal(m[2].value, 7);
  assert.equal(m[3].kind, 'unknown');
  assert.equal(m[3].guess, 4);
  assert.equal(m[4].kind, 'unknown');
});
