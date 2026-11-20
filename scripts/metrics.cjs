// Cohesion (LCOM4, LCOM-HS per class) and Martin's package metrics (Ca, Ce, I, A, D) per src/ file.
// Usage: npm run metrics            (or: node scripts/metrics.cjs [repoRoot])
// Ca/Ce count production imports between src/ files; CaT = test files importing the module (informational).
// A   = exported interfaces + type aliases + abstract classes / all exported declarations (naive).
// A_b = behavioural contracts only: interfaces with methods (or extending another contract) + abstract classes, over
//       those plus classes and functions. DTO interfaces, type aliases and Error subclasses are left out of both sides.
//       Known imprecision: an options bag with a callback property (e.g. WebhookHandlerOptions) counts as a contract.
// Verdict (see docs/adr/0001):
//   entry point  Ca = 0: a composition root, on the main sequence by definition.
//   ok           D_b <= 0.3.
//   ADR-0001     over the threshold and covered by the ADR, while its condition still holds:
//                concrete modules (client, config) only while every production dependent is an entry point;
//                pure contracts (event-source) only while A_b = 1.
//   REVIEW       anything else, including an accepted module that a non-entry module now imports, or D_b = n/a.
// LCOM lists only classes with methods (error classes with fields only have no cohesion to measure).
const path = require('path'), fs = require('fs');
const root = path.resolve(process.argv[2] ?? process.cwd());
const ts = require(require.resolve('typescript', { paths: [root, __dirname] }));
const srcDir = path.join(root, 'src'), testDir = path.join(root, 'test');
const files = d => fs.readdirSync(d).filter(f => f.endsWith('.ts')).map(f => path.join(d, f));
const src = files(srcDir), tests = files(testDir);
const name = f => path.relative(root, f).split(path.sep).join('/');
const parse = f => ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true);

const srcSet = new Set(src);
const resolveSrc = (from, spec) => {
  const p = path.resolve(path.dirname(from), spec);
  return [p, p + '.ts', path.join(p, 'index.ts')].find(c => srcSet.has(c));
};
const imports = {}; // file -> Set(src files it imports)
const ext = {};
for (const f of [...src, ...tests]) {
  const sf = parse(f); imports[f] = new Set(); ext[f] = new Set();
  for (const n of sf.statements) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier) {
      const s = n.moduleSpecifier.text;
      if (!s.startsWith('.')) { ext[f].add(s); continue; }
      const hit = resolveSrc(f, s); if (hit) imports[f].add(hit);
    }
  }
}
const hasMethodMember = members => members.some(m => ts.isMethodSignature(m) ||
  (ts.isPropertySignature(m) && m.type && ts.isFunctionTypeNode(m.type)));

// Interfaces that are behavioural contracts: they declare methods, or extend an interface that is one.
const contracts = new Set();
const allInterfaces = src.flatMap(f => parse(f).statements.filter(ts.isInterfaceDeclaration));
for (let changed = true; changed;) {
  changed = false;
  for (const n of allInterfaces) {
    if (contracts.has(n.name.text)) continue;
    const ext = (n.heritageClauses ?? []).flatMap(h => h.types.map(t => t.expression.getText()));
    if (hasMethodMember(n.members) || ext.some(e => contracts.has(e))) { contracts.add(n.name.text); changed = true; }
  }
}

const rows = [];
for (const f of src) {
  const sf = parse(f);
  let abs = 0, conc = 0, absB = 0, concB = 0, data = 0;
  const decls = [];
  sf.forEachChild(n => {
    const exported = n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    if (ts.isInterfaceDeclaration(n)) {
      abs++; const beh = contracts.has(n.name.text);
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
  rows.push({ module: name(f), dependents: src.filter(g => imports[g].has(f)).map(name), Ca, CaTests: CaT, Ce, I, A, D: Math.abs(A + I - 1), A_beh: AB, D_beh: Math.abs(AB + I - 1),
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
      if (m === 0) { ts.forEachChild(n, visit); return; }
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
// ADR-0001. Concrete + stable, accepted while only composition roots depend on them:
const ACCEPTED_CONCRETE = new Set(['src/client.ts', 'src/config.ts']);
// Pure contracts whose distance comes only from importing DTOs, accepted while they stay pure (A_b = 1):
const ACCEPTED_CONTRACT = new Set(['src/event-source.ts']);
const isEntry = new Set(rows.filter(r => r.Ca === 0).map(r => r.module));
const verdict = r => {
  if (r.Ca === 0) return 'entry point';
  if (Number.isNaN(r.D_beh)) return 'REVIEW (D_b n/a)';
  if (r.D_beh <= 0.3) return 'ok';
  if (ACCEPTED_CONTRACT.has(r.module)) return r.A_beh === 1 ? 'ADR-0001' : 'REVIEW (ADR-0001 void: no longer a pure contract)';
  if (!ACCEPTED_CONCRETE.has(r.module)) return 'REVIEW';
  const inner = r.dependents.filter(d => !isEntry.has(d));
  return inner.length ? `REVIEW (ADR-0001 void: ${inner.join(', ')})` : 'ADR-0001';
};
const r2 = x => Number.isNaN(x) ? 'n/a' : x.toFixed(2);
console.log('## Martin (production imports; CaTests = test files importing it)');
console.log('module | Ca | CaT | Ce | I | A | D | A_b | D_b | verdict | imports | exported decls');
for (const r of rows) console.log([r.module, r.Ca, r.CaTests, r.Ce, r2(r.I), r2(r.A), r2(r.D), r2(r.A_beh), r2(r.D_beh), verdict(r), r.deps, r.decls].join(' | '));
console.log('\n## LCOM');
console.log('class | methods | fields | LCOM4 | LCOM-HS | components | field use');
for (const l of lcom) console.log([l.class, l.methods, l.fields, l.LCOM4, r2(l.LCOM_HS), l.components, l.fieldUse].join(' | '));
