/** Pure, bounded math shared by the canvas and its server-side validator. */
export const GRAPH_LIMITS = {
  source: 512,
  depth: 24,
  nodes: 128,
  tokens: 256,
  samples: 1000,
} as const;
const functions = new Map<string, (value: number) => number>([
  ['sin', Math.sin],
  ['cos', Math.cos],
  ['sqrt', Math.sqrt],
  ['abs', Math.abs],
  ['exp', Math.exp],
  ['log', Math.log],
]);

export type GraphAst =
  | { kind: 'number'; value: number }
  | { kind: 'variable'; name: 'x' | 'a' }
  | { kind: 'unary'; operator: '+' | '-'; value: GraphAst }
  | { kind: 'binary'; operator: '+' | '-' | '*' | '/' | '^'; left: GraphAst; right: GraphAst }
  | { kind: 'call'; name: string; argument: GraphAst };

export function parseGraphExpression(source: string): GraphAst {
  if (typeof source !== 'string' || !source.trim() || source.length > GRAPH_LIMITS.source) {
    throw new Error(`Выражение должно содержать от 1 до ${GRAPH_LIMITS.source} символов.`);
  }
  const tokens: string[] = [];
  let offset = 0;
  while (offset < source.length) {
    if (/\s/.test(source[offset])) {
      offset++;
      continue;
    }
    const match = /^(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[a-zA-Z_]+|[+\-*/^()])/.exec(
      source.slice(offset),
    );
    if (!match) throw new Error(`Недопустимый символ в позиции ${offset + 1}.`);
    tokens.push(match[0]);
    if (tokens.length > GRAPH_LIMITS.tokens) throw new Error('Слишком сложное выражение.');
    offset += match[0].length;
  }
  let index = 0;
  let nodes = 0;
  function node(ast: GraphAst): GraphAst {
    if (++nodes > GRAPH_LIMITS.nodes) throw new Error('Слишком сложное выражение.');
    return ast;
  }
  function expression(minPrecedence: number, depth: number): GraphAst {
    if (depth > GRAPH_LIMITS.depth) throw new Error('Слишком глубокая вложенность.');
    const token = tokens[index++];
    let left: GraphAst;
    if (token === '+' || token === '-') {
      left = node({ kind: 'unary', operator: token, value: expression(3, depth + 1) });
    } else if (token === '(') {
      left = expression(0, depth + 1);
      if (tokens[index++] !== ')') throw new Error('Не хватает закрывающей скобки.');
    } else if (token === 'x' || token === 'a') {
      left = node({ kind: 'variable', name: token });
    } else if (functions.has(token)) {
      if (tokens[index++] !== '(') throw new Error('После функции нужны скобки.');
      const argument = expression(0, depth + 1);
      if (tokens[index++] !== ')') throw new Error('У функции должен быть один аргумент.');
      left = node({ kind: 'call', name: token, argument });
    } else if (token !== undefined && /^(?:\d|\.)/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) throw new Error('Число должно быть конечным.');
      left = node({ kind: 'number', value });
    } else {
      throw new Error('Ожидается число, x, a или математическая функция.');
    }
    while (index < tokens.length) {
      const operator = tokens[index];
      const precedence =
        operator === '+' || operator === '-'
          ? 1
          : operator === '*' || operator === '/'
            ? 2
            : operator === '^'
              ? 3
              : -1;
      if (precedence < minPrecedence) break;
      index++;
      const right = expression(precedence + (operator === '^' ? 0 : 1), depth + 1);
      left = node({
        kind: 'binary',
        operator: operator as '+' | '-' | '*' | '/' | '^',
        left,
        right,
      });
    }
    return left;
  }
  const ast = expression(0, 0);
  if (index !== tokens.length) throw new Error('Между значениями нужен оператор.');
  return ast;
}

export function evaluateGraphExpression(ast: GraphAst, x: number, a: number): number | null {
  if (!Number.isFinite(x) || !Number.isFinite(a)) return null;
  function visit(node: GraphAst): number {
    switch (node.kind) {
      case 'number':
        return node.value;
      case 'variable':
        return node.name === 'x' ? x : a;
      case 'unary':
        return (node.operator === '-' ? -1 : 1) * visit(node.value);
      case 'call':
        return functions.get(node.name)!(visit(node.argument));
      case 'binary': {
        const left = visit(node.left),
          right = visit(node.right);
        switch (node.operator) {
          case '+':
            return left + right;
          case '-':
            return left - right;
          case '*':
            return left * right;
          case '/':
            return left / right;
          case '^':
            return left ** right;
        }
      }
    }
  }
  const value = visit(ast);
  return Number.isFinite(value) ? value : null;
}

export interface GraphBounds {
  a: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}
export function validateGraphBounds(bounds: GraphBounds): void {
  if (
    [bounds.a, bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax].some(
      (n) => !Number.isFinite(n) || Math.abs(n) > 10000,
    ) ||
    bounds.xMax - bounds.xMin < 0.001 ||
    bounds.yMax - bounds.yMin < 0.001
  ) {
    throw new Error('Границы осей должны возрастать и лежать в пределах ±10000.');
  }
}

export function sampleGraph(
  source: string,
  bounds: GraphBounds,
  steps = 240,
): ({ x: number; y: number } | null)[] {
  validateGraphBounds(bounds);
  if (!Number.isInteger(steps) || steps < 2 || steps > GRAPH_LIMITS.samples)
    throw new Error('Недопустимое число отсчётов.');
  const ast = parseGraphExpression(source);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const x = bounds.xMin + ((bounds.xMax - bounds.xMin) * i) / steps;
    const y = evaluateGraphExpression(ast, x, bounds.a);
    return y === null || y < bounds.yMin || y > bounds.yMax ? null : { x, y };
  });
}

export interface GeometryPoints {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}
export function geometryMeasurements(p: GeometryPoints) {
  const AB = Math.hypot(p.ax - p.bx, p.ay - p.by);
  const BC = Math.hypot(p.bx - p.cx, p.by - p.cy);
  const CA = Math.hypot(p.cx - p.ax, p.cy - p.ay);
  const angle = (adjacent1: number, adjacent2: number, opposite: number) => {
    if (adjacent1 < 1e-9 || adjacent2 < 1e-9) return null;
    const cosine = (adjacent1 ** 2 + adjacent2 ** 2 - opposite ** 2) / (2 * adjacent1 * adjacent2);
    return (Math.acos(Math.max(-1, Math.min(1, cosine))) * 180) / Math.PI;
  };
  return {
    lengths: { AB, BC, CA },
    angles: { A: angle(AB, CA, BC), B: angle(AB, BC, CA), C: angle(BC, CA, AB) },
  };
}
