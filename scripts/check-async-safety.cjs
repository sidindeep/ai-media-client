const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(filename) : /\.(?:js|cjs|mjs)$/.test(entry.name) ? [filename] : [];
  });
}

const files = [path.resolve('server.js'), ...sourceFiles(path.resolve('src')), ...sourceFiles(path.resolve('scripts'))];
const violations = [];
for (const filename of files) {
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const asyncFunction = node => node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
    && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  function visit(node) {
    let message;
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Promise' && asyncFunction(node.arguments?.[0]))
      message = 'async Promise executor can leave the outer promise unresolved';
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'forEach' && asyncFunction(node.arguments[0]))
      message = 'async forEach callback is not awaited';
    if (ts.isTryStatement(node) && node.finallyBlock) {
      function checkFinally(child) {
        if (ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child)) {
          const { line, character } = source.getLineAndCharacterOfPosition(child.getStart(source));
          violations.push(`${path.relative(process.cwd(), filename)}:${line + 1}:${character + 1}: return in finally can suppress an error`);
        }
        ts.forEachChild(child, checkFinally);
      }
      checkFinally(node.finallyBlock);
    }
    if (message) {
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${path.relative(process.cwd(), filename)}:${line + 1}:${character + 1}: ${message}`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
if (violations.length) {
  process.stderr.write(violations.join('\n') + '\n');
  process.exitCode = 1;
} else process.stdout.write(`Checked ${files.length} files for unsafe async patterns\n`);
