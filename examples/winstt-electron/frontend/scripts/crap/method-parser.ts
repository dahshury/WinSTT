/**
 * TypeScript source → list of FunctionDescriptor (start/end line, cyclomatic complexity).
 *
 * Mirrors `examples/crap4java/src/crap4java/JavaMethodParser.java`'s
 * MethodScanner + ComplexityCounter. Cyclomatic complexity counts branch
 * nodes per the McCabe definition: each function body starts at 1 and
 * increments on every if/loop/case/catch/?:/&&/||/?? — i.e. every place
 * where control flow can fork.
 */

import ts from "typescript";

export interface FunctionDescriptor {
	complexity: number;
	endLine: number;
	name: string;
	startLine: number; // 1-indexed
}

export function parseFunctions(filePath: string, source: string): FunctionDescriptor[] {
	const sourceFile = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.ESNext,
		/* setParentNodes */ true,
		filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
	);

	const out: FunctionDescriptor[] = [];
	visit(sourceFile, sourceFile, out, []);
	return out;
}

function visit(
	node: ts.Node,
	sf: ts.SourceFile,
	out: FunctionDescriptor[],
	stack: ReadonlyArray<string>
): void {
	if (isFunctionLike(node)) {
		const name = describeName(node, stack);
		const { line: startLine } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
		const { line: endLine } = sf.getLineAndCharacterOfPosition(node.getEnd());
		const complexity = computeComplexity(node);
		out.push({
			name,
			startLine: startLine + 1,
			endLine: endLine + 1,
			complexity,
		});
		const childStack = [...stack, name];
		ts.forEachChild(node, (child) => visit(child, sf, out, childStack));
		return;
	}
	ts.forEachChild(node, (child) => visit(child, sf, out, stack));
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
	return (
		ts.isFunctionDeclaration(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isFunctionExpression(node) ||
		ts.isArrowFunction(node) ||
		ts.isConstructorDeclaration(node) ||
		ts.isGetAccessor(node) ||
		ts.isSetAccessor(node)
	);
}

function describeName(node: ts.FunctionLikeDeclaration, stack: ReadonlyArray<string>): string {
	const parent = node.parent;
	let local = "(anonymous)";
	if (ts.isFunctionDeclaration(node) && node.name) local = node.name.text;
	else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name))
		local = node.name.text;
	else if (ts.isConstructorDeclaration(node)) local = "constructor";
	else if (ts.isGetAccessor(node) && ts.isIdentifier(node.name)) local = `get ${node.name.text}`;
	else if (ts.isSetAccessor(node) && ts.isIdentifier(node.name)) local = `set ${node.name.text}`;
	else if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
		local = parent.name.text;
	else if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name))
		local = parent.name.text;
	else if (parent && ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name))
		local = parent.name.text;
	return stack.length === 0 ? local : `${stack[stack.length - 1]}>${local}`;
}

/**
 * Cyclomatic complexity counter. Walks ONLY this function's body (not nested
 * function bodies — those get their own descriptor). McCabe definition:
 * base 1 + 1 per branching node.
 */
function computeComplexity(fn: ts.FunctionLikeDeclaration): number {
	let cc = 1;
	function walk(node: ts.Node): void {
		// Don't descend into nested functions — their complexity is reported
		// separately via the outer visitor.
		if (node !== fn && isFunctionLike(node)) return;

		if (
			ts.isIfStatement(node) ||
			ts.isForStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isForOfStatement(node) ||
			ts.isWhileStatement(node) ||
			ts.isDoStatement(node) ||
			ts.isCatchClause(node) ||
			ts.isConditionalExpression(node) ||
			ts.isCaseClause(node)
		) {
			cc++;
		}

		// Logical operators that introduce a branch: && || ??
		if (ts.isBinaryExpression(node)) {
			const op = node.operatorToken.kind;
			if (
				op === ts.SyntaxKind.AmpersandAmpersandToken ||
				op === ts.SyntaxKind.BarBarToken ||
				op === ts.SyntaxKind.QuestionQuestionToken
			) {
				cc++;
			}
		}

		ts.forEachChild(node, walk);
	}
	walk(fn);
	return cc;
}
