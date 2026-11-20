// Cohesion (LCOM4, LCOM-HS per class) and Martin's package metrics (Ca, Ce, I, A, D) per src/ file.
// Usage: npm run metrics            (or: node scripts/metrics.cjs [repoRoot])
// Ca/Ce count production imports between src/ files; CaT = test files importing the module (informational).
// A   = exported interfaces + type aliases + abstract classes / all exported declarations (naive).
// A_b = behavioural contracts only: interfaces with methods (or extending one) + abstract classes, over those plus
//       classes and functions. DTO interfaces, type aliases and Error subclasses are left out of both sides.
// Verdict (see docs/adr/0001): ok when D_b <= 0.3; entry points (Ca = 0) are on the main sequence by definition;
// ADR-0001 marks modules accepted in the zone of pain because only composition roots depend on them.
const path = require('path'), fs = require('fs');
const root = path.resolve(process.argv[2] ?? process.cwd());
const ts = require(path.join(root, 'node_modules/typescript'));
const srcDir = path.join(root, 'src'), testDir = path.join(root, 'test');
const files = d => fs.readdirSync(d).filter(f => f.endsWith('.ts')).map(f => path.join(d, f));
const src = files(srcDir), tests = files(testDir);
const name = f => path.relative(root, f).split(path.sep).join('/');
const parse = f => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);

const imports = {}; // file -> Set(internal src files)
const ext = {};
for (const f of [...src, ...tests]) {
  const sf = parse(f); imports[f] = new Set(); ext[f] = new Set();
  sf.forEachChild(n => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const s = n.moduleSpecifier.text;
      if (s.startsWith('.')) imports[f].add(path.resolve(path.dirname(f), s)); else ext[f].add(s);
    }
  });
}
const hasMethodMember = members => members.some(m => ts.isMethodSignature(m) ||
  (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type)));

const rows = [];
for (const f of src) {
  const sf = parse(f);
  let abs = 0, conc = 0, absB = 0, concB = 0, data = 0;
  const decls = [];
  sf.forEachChild(n => {
    const exported = n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    if (ts.isInterfaceDeclaration(n)) {
      abs++; const beh = hasMethodMember(n.members) || (n.heritageClauses?.length ?? 0) > 0;
      if (beh) absB++; else data++; decls.push(`${n.name.text}:${beh ? 'contract' : 'data'}`);
    } else if (ts.isTypeAliasDeclaration(n)) {
      abs++; data++; decls.push(`${n.name.text}:type`);
    } else if (ts.isClassDeclaration(n)) {
      const isAbs = n.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword);
      const isErr = n.heritageClauses?.some(h => h.types.some(t => /Error$/.test(t.expression.getText())));
      if (isAbs) { abs++; absB++; } else { conc++; if (!isErr) concB++; else data++; }
      decls.push(`${n.name?.text}:${isErr ? 'error' : 'class'}`);
    } else if (ts.isFunctionDeclaration(n)) { conc++; concB++; decls.push(`${n.name?.text}()`); }
    else if (ts.isVariableStatement(n)) {
      for (const d of n.declarationList.declarations) {
        const fn = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
        if (fn) { conc++; concB++; decls.push(`${d.name.getText()}()`); } else decls.push(`${d.name.getText()}:const`);
      }
    }
  });
  const Ce = imports[f].size;
  const Ca = src.filter(g => imports[g].has(f)).length;
  const CaT = tests.filter(g => imports[g].has(f)).length;
  const I = Ca + Ce ? Ce / (Ca + Ce) : NaN;
  const A = abs + conc ? abs / (abs + conc) : 0;
  const AB = absB + concB ? absB / (absB + concB) : (abs + conc ? NaN : 0);
  rows.push({ module: name(f), Ca, CaTests: CaT, Ce, I, A, D: Math.abs(A + I - 1), A_beh: AB, D_beh: Math.abs(AB + I - 1),
    deps: [...imports[f]].map(x => path.basename(x)).join(','), decls: decls.join(' ') });
}

// LCOM4 + LCOM-HS per class
const lcom = [];
for (const f of src) {
  const sf = parse(f);
  const visit = n => {
    if (ts.isClassDeclaration(n) && n.name) {
      const fields = new Set(), methods = [];
      for (const m of n.members) {
        if (ts.isPropertyDeclaration(m)) fields.add(m.name.getText());
        if (ts.isConstructorDeclaration(m)) for (const p of m.parameters)
          if (p.modifiers?.some(x => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ReadonlyKeyword, ts.SyntaxKind.PublicKeyword, ts.SyntaxKind.ProtectedKeyword].includes(x.kind))) fields.add(p.name.getText());
        if ((ts.isMethodDeclaration(m) || ts.isGetAccessor(m)) && m.body) methods.push(m);
      }
      const mnames = methods.map(m => m.name.getText());
      const uses = {};
      for (const m of methods) {
        const u = { f: new Set(), m: new Set() };
        const walk = x => {
          if (ts.isPropertyAccessExpression(x) && x.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const k = x.name.text; if (fields.has(k)) u.f.add(k); else if (mnames.includes(k)) u.m.add(k);
          }
          ts.forEachChild(x, walk);
        };
        walk(m.body); uses[m.name.getText()] = u;
      }
      // union-find over methods
      const parent = Object.fromEntries(mnames.map(k => [k, k]));
      const find = k => parent[k] === k ? k : (parent[k] = find(parent[k]));
      const join = (a, b) => { parent[find(a)] = find(b); };
      for (const a of mnames) for (const b of mnames) if (a < b) {
        const ua = uses[a], ub = uses[b];
        if ([...ua.f].some(x => ub.f.has(x)) || ua.m.has(b) || ub.m.has(a)) join(a, b);
      }
      const comps = {};
      for (const k of mnames) (comps[find(k)] ??= []).push(k);
      const m = mnames.length, a = fields.size;
      const mu = [...fields].map(fl => mnames.filter(k => uses[k].f.has(fl)).length);
      const hs = m > 1 && a ? ((mu.reduce((s, x) => s + x, 0) / a) - m) / (1 - m) : NaN;
      lcom.push({ class: `${name(f)}#${n.name.text}`, methods: m, fields: a, LCOM4: Object.keys(comps).length, LCOM_HS: hs,
        components: Object.values(comps).map(c => `{${c.join(',')}}`).join(' '),
        fieldUse: [...fields].map((fl, i) => `${fl}:${mu[i]}`).join(' ') });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}
// ADR-0001: stable + concrete, but only composition roots depend on them; event-source is a pure contract.
const ACCEPTED = new Set(['src/client.ts', 'src/config.ts', 'src/event-source.ts']);
const verdict = r => r.Ca === 0 ? 'entry point' : !(r.D_beh > 0.3) ? 'ok' : ACCEPTED.has(r.module) ? 'ADR-0001' : 'REVIEW';
const r2 = x => Number.isNaN(x) ? 'n/a' : x.toFixed(2);
console.log('## Martin (production imports; CaTests = test files importing it)');
console.log('module | Ca | CaT | Ce | I | A | D | A_b | D_b | verdict | imports | exported decls');
for (const r of rows) console.log([r.module, r.Ca, r.CaTests, r.Ce, r2(r.I), r2(r.A), r2(r.D), r2(r.A_beh), r2(r.D_beh), verdict(r), r.deps, r.decls].join(' | '));
console.log('\n## LCOM');
console.log('class | methods | fields | LCOM4 | LCOM-HS | components | field use');
for (const l of lcom) console.log([l.class, l.methods, l.fields, l.LCOM4, r2(l.LCOM_HS), l.components, l.fieldUse].join(' | '));
