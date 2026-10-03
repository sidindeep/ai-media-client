const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../web/src/domain/prompt-scroll.ts');
const compiled = new Module(filename, module);
compiled._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText, filename);
const { createPromptLineScroll } = compiled.exports;
function field(top = 0) {
  return { scrollTop: top, scrollHeight: 630, clientHeight: 105, selectionStart: 0, selectionEnd: 0,
    calls: [], scrollTo(options) { this.calls.push(options); } };
}
function wheel(deltaY = 100, options = {}) {
  return { deltaY, deltaX: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, cancelable: true,
    prevented: false, preventDefault() { this.prevented = true; }, ...options };
}

test('the initial wheel event sets a whole-line destination without a delayed correction', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = field(), event = wheel();
  const scroll = createPromptLineScroll(() => 21, () => false);
  scroll.wheel(element, event);
  assert.equal(event.prevented, true);
  assert.deepEqual(element.calls, [{ top: 105, behavior: 'smooth' }]);
  element.scrollTop = 105;
  t.mock.timers.tick(2000);
  assert.equal(element.calls.length, 1, 'nothing moves the text again after the wheel stops');
  assert.equal(element.scrollTop, 105);
});

test('rapid wheel input accumulates destinations; reversal responds from the visible position', () => {
  const element = field(), scroll = createPromptLineScroll(() => 21, () => false);
  scroll.wheel(element, wheel());
  element.scrollTop = 16;
  scroll.wheel(element, wheel());
  assert.equal(element.calls.at(-1).top, 210);
  element.scrollTop = 63;
  scroll.wheel(element, wheel(-21));
  assert.equal(element.calls.at(-1).top, 42, 'reversing does not keep travelling to an old destination');
});

test('fine pixel scrolling, touchpad inertia, zoom and horizontal scroll remain native', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const element = field(34), scroll = createPromptLineScroll(() => 21, () => false);
  for (const event of [wheel(4), wheel(31.5), wheel(0), wheel(100, { ctrlKey: true }),
    wheel(100, { metaKey: true }), wheel(100, { shiftKey: true }), wheel(30, { deltaX: 100 }),
    wheel(100, { cancelable: false })]) {
    scroll.wheel(element, event);
    assert.equal(event.prevented, false);
  }
  t.mock.timers.tick(2000);
  assert.deepEqual(element.calls, []);
  assert.equal(element.scrollTop, 34);
});

test('text selection and pointer dragging never trigger line scrolling', () => {
  const element = field(34), scroll = createPromptLineScroll(() => 21, () => false);
  element.selectionEnd = 12;
  const selected = wheel();
  scroll.wheel(element, selected);
  assert.equal(selected.prevented, false);
  element.selectionEnd = 0;
  scroll.pointerStart();
  const dragging = wheel();
  scroll.wheel(element, dragging);
  assert.equal(dragging.prevented, false);
  assert.deepEqual(element.calls, []);
  scroll.pointerEnd();
  scroll.wheel(element, wheel(21));
  assert.equal(element.calls.at(-1).top, 63);
});

test('line/page units and reduced motion use an immediate whole-line destination', () => {
  const element = field(), scroll = createPromptLineScroll(() => 21, () => true);
  scroll.wheel(element, wheel(3, { deltaMode: 1 }));
  assert.deepEqual(element.calls.at(-1), { top: 63, behavior: 'instant' });
  element.scrollTop = 63;
  scroll.wheel(element, wheel(1, { deltaMode: 2 }));
  assert.deepEqual(element.calls.at(-1), { top: 168, behavior: 'instant' });
});

test('starting a selection stops native animation at its current position', () => {
  const element = field(), scroll = createPromptLineScroll(() => 21, () => false);
  scroll.wheel(element, wheel());
  element.scrollTop = 34;
  scroll.pointerStart();
  assert.deepEqual(element.calls.at(-1), { top: 34, behavior: 'instant' });
  element.selectionEnd = 10;
  scroll.pointerEnd();
  const event = wheel();
  scroll.wheel(element, event);
  assert.equal(event.prevented, false);
  assert.equal(element.calls.length, 2, 'no new movement while selecting text');
});

test('scroll bounds allow the page to scroll at an edge and cancel resets a stale destination', () => {
  const element = field(), scroll = createPromptLineScroll(() => 21, () => false);
  const atTop = wheel(-100);
  scroll.wheel(element, atTop);
  assert.equal(atTop.prevented, false);
  element.scrollTop = 504;
  scroll.wheel(element, wheel());
  assert.equal(element.calls.at(-1).top, 525);
  element.scrollTop = 525;
  const atBottom = wheel();
  scroll.wheel(element, atBottom);
  assert.equal(atBottom.prevented, false);
  element.scrollTop = 0;
  scroll.wheel(element, wheel());
  scroll.cancel();
  element.scrollTop = 42;
  scroll.wheel(element, wheel(21));
  assert.equal(element.calls.at(-1).top, 63);
});
