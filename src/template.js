// 简易 Mustache 引擎
// 支持：{{var}}、{{var.path}}、{{var | "default"}}
//      {{#if expr}}...{{else}}...{{/if}}
//      {{#each arr}}...{{/each}}

function getPath(obj, path) {
  if (!path) return undefined;
  return path.split('.').reduce(
    (o, k) => (o == null ? undefined : o[k]),
    obj
  );
}

function evalExpr(expr, data) {
  expr = expr.trim();

  // a == "b"
  let m = expr.match(/^(\S+)\s*==\s*["']?([^"']*)["']?$/);
  if (m) {
    const v = getPath(data, m[1]);
    return String(v) === m[2];
  }
  // a != "b"
  m = expr.match(/^(\S+)\s*!=\s*["']?([^"']*)["']?$/);
  if (m) {
    const v = getPath(data, m[1]);
    return String(v) !== m[2];
  }
  // 普通路径 → truthy
  const val = getPath(data, expr);
  return !!val && val !== '0' && val !== 'false';
}

function renderString(tpl, data) {
  if (typeof tpl !== 'string') return tpl;

  let out = tpl;
  let guard;

  // {{#if ...}}...{{/if}}
  const ifRe = /\{\{#if\s+([^}]+)\}\}([\s\S]*?)\{\{\/if\}\}/;
  guard = 0;
  while (ifRe.test(out) && guard++ < 50) {
    out = out.replace(ifRe, (_, expr, body) => {
      let truePart = body;
      let falsePart = '';
      const elseIdx = body.indexOf('{{else}}');
      if (elseIdx !== -1) {
        truePart = body.slice(0, elseIdx);
        falsePart = body.slice(elseIdx + 8);
      }
      const cond = evalExpr(expr, data);
      return renderString(cond ? truePart : falsePart, data);
    });
  }

  // {{#each ...}}...{{/each}}
  const eachRe = /\{\{#each\s+([^}]+)\}\}([\s\S]*?)\{\{\/each\}\}/;
  guard = 0;
  while (eachRe.test(out) && guard++ < 50) {
    out = out.replace(eachRe, (_, expr, body) => {
      const arr = getPath(data, expr.trim());
      if (!Array.isArray(arr)) return '';
      return arr.map((item, i) => {
        let b = body.replace(/\{\{this\}\}/g, String(item));
        b = b.replace(/\{\{@index\}\}/g, String(i));
        return renderString(b, item);
      }).join('');
    });
  }

  // {{var}} 或 {{var | "default"}}
  out = out.replace(/\{\{([^{}#/][^}]*)\}\}/g, (_, expr) => {
    const parts = expr.split('|').map(s => s.trim());
    const path = parts[0];
    let val = getPath(data, path);
    if ((val === undefined || val === null || val === '') && parts.length > 1) {
      const def = parts[1].replace(/^["']|["']$/g, '');
      return def;
    }
    return val != null ? String(val) : '';
  });

  return out;
}

function renderTemplate(tpl, data) {
  if (typeof tpl === 'string') return renderString(tpl, data);
  if (Array.isArray(tpl)) return tpl.map(v => renderTemplate(v, data));
  if (tpl && typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) {
      out[k] = renderTemplate(v, data);
    }
    return out;
  }
  return tpl;
}

module.exports = { renderTemplate };
