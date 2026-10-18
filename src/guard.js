'use strict';
// Relay's guard for worker sessions: a PreToolUse hook in each worker account's settings.json. Claude Code's own deny
// rules match a command as written, so `"/full/path/bin/tool" freeze` or `./bin/tool freeze` slips past a rule for
// `bin/tool freeze *`. Before every Bash call this looks at each part of the command (split at && || ; | and new
// lines), with quotes and any leading path removed, and refuses it when a part matches a rule in
// Settings › Commands workers may never run. It reads that list from ~/.relay/settings.json each time.
// Exit 2 refuses the call and tells Claude why; anything unexpected exits 0 (the deny rules still apply then).

const fs = require('fs');
const os = require('os');
const path = require('path');

const home = () => process.env.RELAY_HOME || path.join(os.homedir(), '.relay');

// "Bash(bin/claudeidea freeze *)" -> a matcher on one command part; only Bash rules concern the guard.
function compile(rule) {
  const m = /^Bash\((.+)\)$/.exec(String(rule).trim());
  if (!m) return null;
  const body = m[1].trim();
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');
  return { rule, test: (s) => re.test(s) || re.test(`${s} `) };
}

const unquote = (s) => s.replace(/["']/g, '');

// The program is the first word, or the whole first quoted string ("/My Project/bin/tool" has a space in it).
function splitProgram(s) {
  const q = s[0];
  if (q === '"' || q === "'") {
    const end = s.indexOf(q, 1);
    if (end > 0) return [s.slice(1, end), s.slice(end + 1)];
  }
  const sp = s.search(/\s/);
  return sp < 0 ? [s, ''] : [s.slice(0, sp), s.slice(sp)];
}

// The ways one part of a command can name the same program: as written, without quotes, and with the path in front of
// the program cut back step by step ("/a/b/bin/tool x" -> "b/bin/tool x" -> "bin/tool x" -> "tool x"; "./bin/tool x").
function variants(part) {
  const out = new Set();
  const s = part.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ''); // VAR=value in front
  out.add(s);
  out.add(unquote(s));
  const [prog, rest] = splitProgram(s);
  const segs = prog.replace(/^\.\//, '').split('/');
  for (let i = 0; i < segs.length; i++) {
    const p = segs.slice(i).join('/');
    out.add(p + rest);
    out.add(p + unquote(rest));
  }
  return [...out].map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function parts(command) {
  return String(command).split(/&&|\|\||[;|\n]/).map((p) => p.trim()).filter(Boolean);
}

// Which rule a command breaks, or null.
function check(command, rules) {
  const matchers = rules.map(compile).filter(Boolean);
  for (const p of parts(command)) {
    for (const v of variants(p)) {
      for (const m of matchers) if (m.test(v)) return m.rule;
    }
  }
  return null;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { input += d; });
  process.stdin.on('end', () => {
    try {
      const ev = JSON.parse(input);
      if (ev.tool_name !== 'Bash') process.exit(0);
      const rules = JSON.parse(fs.readFileSync(path.join(home(), 'settings.json'), 'utf8')).deniedTools || [];
      const hit = check(ev.tool_input && ev.tool_input.command, rules);
      if (hit) {
        process.stderr.write(`Relay refused this command: it matches "${hit}" (Settings › Commands workers may never run). Do not try another way to run it; report that it is reserved for the dispatcher.\n`);
        process.exit(2);
      }
    } catch { /* a guard that cannot read its input must not stop the work */ }
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { check, variants, parts, compile };
