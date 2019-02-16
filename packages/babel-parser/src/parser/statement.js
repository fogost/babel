// @flow

import * as N from "../types";
import { types as tt, type TokenType } from "../tokenizer/types";
import ExpressionParser from "./expression";
import {
  isIdentifierChar,
  isIdentifierStart,
  keywordRelationalOperator,
} from "../util/identifier";
import { lineBreak, skipWhiteSpace } from "../util/whitespace";
import * as charCodes from "charcodes";

// Reused empty array added for node fields that are always empty.

const empty = [];

const loopLabel = { kind: "loop" },
  switchLabel = { kind: "switch" };

export default class StatementParser extends ExpressionParser {
  // ### Statement parsing

  // Parse a program. Initializes the parser, reads any number of
  // statements, and wraps them in a Program node.  Optionally takes a
  // `program` argument.  If present, the statements will be appended
  // to its body instead of creating a new node.

  parseTopLevel(file: N.File, program: N.Program): N.File {
    program.sourceType = this.options.sourceType;

    program.interpreter = this.parseInterpreterDirective();

    this.parseBlockBody(program, true, true, tt.eof);

    file.program = this.finishNode(program, "Program");
    file.comments = this.state.comments;

    if (this.options.tokens) file.tokens = this.state.tokens;

    return this.finishNode(file, "File");
  }

  // TODO

  stmtToDirective(stmt: N.Statement): N.Directive {
    const expr = stmt.expression;

    const directiveLiteral = this.startNodeAt(expr.start, expr.loc.start);
    const directive = this.startNodeAt(stmt.start, stmt.loc.start);

    const raw = this.state.input.slice(expr.start, expr.end);
    const val = (directiveLiteral.value = raw.slice(1, -1)); // remove quotes

    this.addExtra(directiveLiteral, "raw", raw);
    this.addExtra(directiveLiteral, "rawValue", val);

    directive.value = this.finishNodeAt(
      directiveLiteral,
      "DirectiveLiteral",
      expr.end,
      expr.loc.end,
    );

    return this.finishNodeAt(directive, "Directive", stmt.end, stmt.loc.end);
  }

  parseInterpreterDirective(): N.InterpreterDirective | null {
    if (!this.match(tt.interpreterDirective)) {
      return null;
    }

    const node = this.startNode();
    node.value = this.state.value;
    this.next();
    return this.finishNode(node, "InterpreterDirective");
  }

  isLet(context: ?string): boolean {
    if (!this.isContextual("let")) {
      return false;
    }
    skipWhiteSpace.lastIndex = this.state.pos;
    const skip = skipWhiteSpace.exec(this.state.input);
    // $FlowIgnore
    const next = this.state.pos + skip[0].length;
    const nextCh = this.state.input.charCodeAt(next);
    // For ambiguous cases, determine if a LexicalDeclaration (or only a
    // Statement) is allowed here. If context is not empty then only a Statement
    // is allowed. However, `let [` is an explicit negative lookahead for
    // ExpressionStatement, so special-case it first.
    if (nextCh === charCodes.leftSquareBracket) return true;
    if (context) return false;

    if (nextCh === charCodes.leftCurlyBrace) return true;

    if (isIdentifierStart(nextCh)) {
      let pos = next + 1;
      while (isIdentifierChar(this.state.input.charCodeAt(pos))) {
        ++pos;
      }
      const ident = this.state.input.slice(next, pos);
      if (!keywordRelationalOperator.test(ident)) return true;
    }
    return false;
  }

  // Parse a single statement.
  //
  // If expecting a statement and finding a slash operator, parse a
  // regular expression literal. This is to handle cases like
  // `if (foo) /blah/.exec(foo)`, where looking at the previous token
  // does not help.

  parseStatement(context: ?string, topLevel?: boolean): N.Statement {
    if (this.match(tt.at)) {
      this.parseDecorators(true);
    }
    return this.parseStatementContent(context, topLevel);
  }

  parseStatementContent(context: ?string, topLevel: ?boolean): N.Statement {
    let starttype = this.state.type;
    const node = this.startNode();
    let kind;

    if (this.isLet(context)) {
      starttype = tt._var;
      kind = "let";
    }

    // Most types of statements are recognized by the keyword they
    // start with. Many are trivial to parse, some require a bit of
    // complexity.

    switch (starttype) {
      case tt._break:
      case tt._continue:
        // $FlowFixMe
        return this.parseBreakContinueStatement(node, starttype.keyword);
      case tt._debugger:
        return this.parseDebuggerStatement(node);
      case tt._do:
        return this.parseDoStatement(node);
      case tt._for:
        return this.parseForStatement(node);
      case tt._function: {
        if (this.lookahead().type === tt.dot) break;
        if (
          context &&
          (this.state.strict || (context !== "if" && context !== "label"))
        ) {
          this.raise(
            this.state.start,
            "Function declaration not allowed in this context",
          );
        }
        const result = this.parseFunctionStatement(node);

        // TODO: Remove this once we have proper scope tracking in place.
        if (context && result.generator) {
          this.unexpected(node.start);
        }

        return result;
      }
      case tt._class:
        if (context) this.unexpected();
        return this.parseClass(node, true);

      case tt._if:
        return this.parseIfStatement(node);
      case tt._return:
        return this.parseReturnStatement(node);
      case tt._switch:
        return this.parseSwitchStatement(node);
      case tt._throw:
        return this.parseThrowStatement(node);
      case tt._try:
        return this.parseTryStatement(node);

      case tt._const:
      case tt._var:
        kind = kind || this.state.value;
        if (context && kind !== "var") this.unexpected();
        return this.parseVarStatement(node, kind);

      case tt._while:
        return this.parseWhileStatement(node);
      case tt._with:
        return this.parseWithStatement(node);
      case tt.braceL:
        return this.parseBlock();
      case tt.semi:
        return this.parseEmptyStatement(node);
      case tt._export:
      case tt._import: {
        const nextToken = this.lookahead();
        if (nextToken.type === tt.parenL || nextToken.type === tt.dot) {
          break;
        }

        if (!this.options.allowImportExportEverywhere && !topLevel) {
          this.raise(
            this.state.start,
            "'import' and 'export' may only appear at the top level",
          );
        }

        this.next();

        let result;
        if (starttype === tt._import) {
          result = this.parseImport(node);

          if (
            result.type === "ImportDeclaration" &&
            (!result.importKind || result.importKind === "value")
          ) {
            this.sawUnambiguousESM = true;
          }
        } else {
          result = this.parseExport(node);

          if (
            (result.type === "ExportNamedDeclaration" &&
              (!result.exportKind || result.exportKind === "value")) ||
            (result.type === "ExportAllDeclaration" &&
              (!result.exportKind || result.exportKind === "value")) ||
            result.type === "ExportDefaultDeclaration"
          ) {
            this.sawUnambiguousESM = true;
          }
        }

        this.assertModuleNodeAllowed(node);

        return result;
      }
      case tt.name:
        if (this.isContextual("async")) {
          // peek ahead and see if next token is a function
          const state = this.state.clone();
          this.next();
          if (this.match(tt._function) && !this.canInsertSemicolon()) {
            if (context) {
              this.raise(
                this.state.lastTokStart,
                "Function declaration not allowed in this context",
              );
            }
            this.next();
            return this.parseFunction(node, true, false, true);
          } else {
            this.state = state;
          }
        }
    }

    // If the statement does not start with a statement keyword or a
    // brace, it's an ExpressionStatement or LabeledStatement. We
    // simply start parsing an expression, and afterwards, if the
    // next token is a colon and the expression was a simple
    // Identifier node, we switch to interpreting it as a label.
    const maybeName = this.state.value;
    const expr = this.parseExpression();

    if (
      starttype === tt.name &&
      expr.type === "Identifier" &&
      this.eat(tt.colon)
    ) {
      return this.parseLabeledStatement(node, maybeName, expr, context);
    } else {
      return this.parseExpressionStatement(node, expr);
    }
  }

  assertModuleNodeAllowed(node: N.Node): void {
    if (!this.options.allowImportExportEverywhere && !this.inModule) {
      this.raise(
        node.start,
        `'import' and 'export' may appear only with 'sourceType: "module"'`,
        {
          code: "BABEL_PARSER_SOURCETYPE_MODULE_REQUIRED",
        },
      );
    }
  }

  takeDecorators(node: N.HasDecorators): void {
    const decorators = this.state.decoratorStack[
      this.state.decoratorStack.length - 1
    ];
    if (decorators.length) {
      node.decorators = decorators;
      this.resetStartLocationFromNode(node, decorators[0]);
      this.state.decoratorStack[this.state.decoratorStack.length - 1] = [];
    }
  }

  canHaveLeadingDecorator(): boolean {
    return this.match(tt._class);
  }

  parseDecorators(allowExport?: boolean): void {
    const currentContextDecorators = this.state.decoratorStack[
      this.state.decoratorStack.length - 1
    ];
    while (this.match(tt.at)) {
      const decorator = this.parseDecorator();
      currentContextDecorators.push(decorator);
    }

    if (this.match(tt._export)) {
      if (!allowExport) {
        this.unexpected();
      }

      if (
        this.hasPlugin("decorators") &&
        !this.getPluginOption("decorators", "decoratorsBeforeExport")
      ) {
        this.raise(
          this.state.start,
          "Using the export keyword between a decorator and a class is not allowed. " +
            "Please use `export @dec class` instead.",
        );
      }
    } else if (!this.canHaveLeadingDecorator()) {
      this.raise(
        this.state.start,
        "Leading decorators must be attached to a class declaration",
      );
    }
  }

  parseDecorator(): N.Decorator {
    this.expectOnePlugin(["decorators-legacy", "decorators"]);

    const node = this.startNode();
    this.next();

    if (this.hasPlugin("decorators")) {
      // Every time a decorator class expression is evaluated, a new empty array is pushed onto the stack
      // So that the decorators of any nested class expressions will be dealt with separately
      this.state.decoratorStack.push([]);

      const startPos = this.state.start;
      const startLoc = this.state.startLoc;
      let expr: N.Expression;

      if (this.eat(tt.parenL)) {
        expr = this.parseExpression();
        this.expect(tt.parenR);
      } else {
        expr = this.parseIdentifier(false);

        while (this.eat(tt.dot)) {
          const node = this.startNodeAt(startPos, startLoc);
          node.object = expr;
          node.property = this.parseIdentifier(true);
          node.computed = false;
          expr = this.finishNode(node, "MemberExpression");
        }
      }

      node.expression = this.parseMaybeDecoratorArguments(expr);
      this.state.decoratorStack.pop();
    } else {
      node.expression = this.parseMaybeAssign();
    }
    return this.finishNode(node, "Decorator");
  }

  parseMaybeDecoratorArguments(expr: N.Expression): N.Expression {
    if (this.eat(tt.parenL)) {
      const node = this.startNodeAtNode(expr);
      node.callee = expr;
      node.arguments = this.parseCallExpressionArguments(tt.parenR, false);
      this.toReferencedList(node.arguments);
      return this.finishNode(node, "CallExpression");
    }

    return expr;
  }

  parseBreakContinueStatement(
    node: N.BreakStatement | N.ContinueStatement,
    keyword: string,
  ): N.BreakStatement | N.ContinueStatement {
    const isBreak = keyword === "break";
    this.next();

    if (this.isLineTerminator()) {
      node.label = null;
    } else if (!this.match(tt.name)) {
      this.unexpected();
    } else {
      node.label = this.parseIdentifier();
      this.semicolon();
    }

    // Verify that there is an actual destination to break or
    // continue to.
    let i;
    for (i = 0; i < this.state.labels.length; ++i) {
      const lab = this.state.labels[i];
      if (node.label == null || lab.name === node.label.name) {
        if (lab.kind != null && (isBreak || lab.kind === "loop")) break;
        if (node.label && isBreak) break;
      }
    }
    if (i === this.state.labels.length) {
      this.raise(node.start, "Unsyntactic " + keyword);
    }
    return this.finishNode(
      node,
      isBreak ? "BreakStatement" : "ContinueStatement",
    );
  }

  parseDebuggerStatement(node: N.DebuggerStatement): N.DebuggerStatement {
    this.next();
    this.semicolon();
    return this.finishNode(node, "DebuggerStatement");
  }

  parseDoStatement(node: N.DoWhileStatement): N.DoWhileStatement {
    this.next();
    this.state.labels.push(loopLabel);

    node.body =
      // For the smartPipelines plugin: Disable topic references from outer
      // contexts within the loop body. They are permitted in test expressions,
      // outside of the loop body.
      this.withTopicForbiddingContext(() =>
        // Parse the loop body's body.
        this.parseStatement("do"),
      );

    this.state.labels.pop();

    this.expect(tt._while);
    node.test = this.parseParenExpression();
    this.eat(tt.semi);
    return this.finishNode(node, "DoWhileStatement");
  }

  // Disambiguating between a `for` and a `for`/`in` or `for`/`of`
  // loop is non-trivial. Basically, we have to parse the init `var`
  // statement or expression, disallowing the `in` operator (see
  // the second parameter to `parseExpression`), and then check
  // whether the next token is `in` or `of`. When there is no init
  // part (semicolon immediately after the opening parenthesis), it
  // is a regular `for` loop.

  parseForStatement(node: N.Node): N.ForLike {
    this.next();
    this.state.labels.push(loopLabel);

    let awaitAt = -1;
    if (
      (this.state.inAsync ||
        (!this.state.inFunction && this.options.allowAwaitOutsideFunction)) &&
      this.eatContextual("await")
    ) {
      awaitAt = this.state.lastTokStart;
    }
    this.expect(tt.parenL);

    if (this.match(tt.semi)) {
      if (awaitAt > -1) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, null);
    }

    const isLet = this.isLet();
    if (this.match(tt._var) || this.match(tt._const) || isLet) {
      const init = this.startNode();
      const kind = isLet ? "let" : this.state.value;
      this.next();
      this.parseVar(init, true, kind);
      this.finishNode(init, "VariableDeclaration");

      if (this.match(tt._in) || this.isContextual("of")) {
        if (init.declarations.length === 1) {
          const declaration = init.declarations[0];
          const isForInInitializer =
            kind === "var" &&
            declaration.init &&
            declaration.id.type != "ObjectPattern" &&
            declaration.id.type != "ArrayPattern" &&
            !this.isContextual("of");
          if (this.state.strict && isForInInitializer) {
            this.raise(this.state.start, "for-in initializer in strict mode");
          } else if (isForInInitializer || !declaration.init) {
            return this.parseForIn(node, init, awaitAt);
          }
        }
      }
      if (awaitAt > -1) {
        this.unexpected(awaitAt);
      }
      return this.parseFor(node, init);
    }

    const refShorthandDefaultPos = { start: 0 };
    const init = this.parseExpression(true, refShorthandDefaultPos);
    if (this.match(tt._in) || this.isContextual("of")) {
      const description = this.isContextual("of")
        ? "for-of statement"
        : "for-in statement";
      this.toAssignable(init, undefined, description);
      this.checkLVal(init, undefined, undefined, description);
      return this.parseForIn(node, init, awaitAt);
    } else if (refShorthandDefaultPos.start) {
      this.unexpected(refShorthandDefaultPos.start);
    }
    if (awaitAt > -1) {
      this.unexpected(awaitAt);
    }
    return this.parseFor(node, init);
  }

  parseFunctionStatement(node: N.FunctionDeclaration): N.FunctionDeclaration {
    this.next();
    return this.parseFunction(node, true);
  }

  parseIfStatement(node: N.IfStatement): N.IfStatement {
    this.next();
    node.test = this.parseParenExpression();
    node.consequent = this.parseStatement("if");
    node.alternate = this.eat(tt._else) ? this.parseStatement("if") : null;
    return this.finishNode(node, "IfStatement");
  }

  parseReturnStatement(node: N.ReturnStatement): N.ReturnStatement {
    if (!this.state.inFunction && !this.options.allowReturnOutsideFunction) {
      this.raise(this.state.start, "'return' outside of function");
    }

    this.next();

    // In `return` (and `break`/`continue`), the keywords with
    // optional arguments, we eagerly look for a semicolon or the
    // possibility to insert one.

    if (this.isLineTerminator()) {
      node.argument = null;
    } else {
      node.argument = this.parseExpression();
      this.semicolon();
    }

    return this.finishNode(node, "ReturnStatement");
  }

  parseSwitchStatement(node: N.SwitchStatement): N.SwitchStatement {
    this.next();
    node.discriminant = this.parseParenExpression();
    const cases = (node.cases = []);
    this.expect(tt.braceL);
    this.state.labels.push(switchLabel);

    // Statements under must be grouped (by label) in SwitchCase
    // nodes. `cur` is used to keep the node that we are currently
    // adding statements to.

    let cur;
    for (let sawDefault; !this.match(tt.braceR); ) {
      if (this.match(tt._case) || this.match(tt._default)) {
        const isCase = this.match(tt._case);
        if (cur) this.finishNode(cur, "SwitchCase");
        cases.push((cur = this.startNode()));
        cur.consequent = [];
        this.next();
        if (isCase) {
          cur.test = this.parseExpression();
        } else {
          if (sawDefault) {
            this.raise(this.state.lastTokStart, "Multiple default clauses");
          }
          sawDefault = true;
          cur.test = null;
        }
        this.expect(tt.colon);
      } else {
        if (cur) {
          cur.consequent.push(this.parseStatement(null));
        } else {
          this.unexpected();
        }
      }
    }
    if (cur) this.finishNode(cur, "SwitchCase");
    this.next(); // Closing brace
    this.state.labels.pop();
    return this.finishNode(node, "SwitchStatement");
  }

  parseThrowStatement(node: N.ThrowStatement): N.ThrowStatement {
    this.next();
    if (
      lineBreak.test(
        this.state.input.slice(this.state.lastTokEnd, this.state.start),
      )
    ) {
      this.raise(this.state.lastTokEnd, "Illegal newline after throw");
    }
    node.argument = this.parseExpression();
    this.semicolon();
    return this.finishNode(node, "ThrowStatement");
  }

  parseTryStatement(node: N.TryStatement): N.TryStatement {
    this.next();

    node.block = this.parseBlock();
    node.handler = null;

    if (this.match(tt._catch)) {
      const clause = this.startNode();
      this.next();
      if (this.match(tt.parenL)) {
        this.expect(tt.parenL);
        clause.param = this.parseBindingAtom();
        const clashes: any = Object.create(null);
        this.checkLVal(clause.param, true, clashes, "catch clause");
        this.expect(tt.parenR);
      } else {
        clause.param = null;
      }

      clause.body =
        // For the smartPipelines plugin: Disable topic references from outer
        // contexts within the function body. They are permitted in function
        // default-parameter expressions, which are part of the outer context,
        // outside of the function body.
        this.withTopicForbiddingContext(() =>
          // Parse the catch clause's body.
          this.parseBlock(false),
        );

      node.handler = this.finishNode(clause, "CatchClause");
    }

    node.guardedHandlers = empty;
    node.finalizer = this.eat(tt._finally) ? this.parseBlock() : null;

    if (!node.handler && !node.finalizer) {
      this.raise(node.start, "Missing catch or finally clause");
    }

    return this.finishNode(node, "TryStatement");
  }

  parseVarStatement(
    node: N.VariableDeclaration,
    kind: "var" | "let" | "const",
  ): N.VariableDeclaration {
    this.next();
    this.parseVar(node, false, kind);
    this.semicolon();
    return this.finishNode(node, "VariableDeclaration");
  }

  parseWhileStatement(node: N.WhileStatement): N.WhileStatement {
    this.next();
    node.test = this.parseParenExpression();
    this.state.labels.push(loopLabel);

    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the loop body.
      // They are permitted in test expressions, outside of the loop body.
      this.withTopicForbiddingContext(() =>
        // Parse loop body.
        this.parseStatement("while"),
      );

    this.state.labels.pop();

    return this.finishNode(node, "WhileStatement");
  }

  parseWithStatement(node: N.WithStatement): N.WithStatement {
    if (this.state.strict) {
      this.raise(this.state.start, "'with' in strict mode");
    }
    this.next();
    node.object = this.parseParenExpression();

    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the function body.
      // They are permitted in function default-parameter expressions, which are
      // part of the outer context, outside of the function body.
      this.withTopicForbiddingContext(() =>
        // Parse the statement body.
        this.parseStatement("with"),
      );

    return this.finishNode(node, "WithStatement");
  }

  parseEmptyStatement(node: N.EmptyStatement): N.EmptyStatement {
    this.next();
    return this.finishNode(node, "EmptyStatement");
  }

  parseLabeledStatement(
    node: N.LabeledStatement,
    maybeName: string,
    expr: N.Identifier,
    context: ?string,
  ): N.LabeledStatement {
    for (const label of this.state.labels) {
      if (label.name === maybeName) {
        this.raise(expr.start, `Label '${maybeName}' is already declared`);
      }
    }

    const kind = this.state.type.isLoop
      ? "loop"
      : this.match(tt._switch)
      ? "switch"
      : null;
    for (let i = this.state.labels.length - 1; i >= 0; i--) {
      const label = this.state.labels[i];
      if (label.statementStart === node.start) {
        label.statementStart = this.state.start;
        label.kind = kind;
      } else {
        break;
      }
    }

    this.state.labels.push({
      name: maybeName,
      kind: kind,
      statementStart: this.state.start,
    });
    node.body = this.parseStatement(
      context
        ? context.indexOf("label") === -1
          ? context + "label"
          : context
        : "label",
    );

    this.state.labels.pop();
    node.label = expr;
    return this.finishNode(node, "LabeledStatement");
  }

  parseExpressionStatement(
    node: N.ExpressionStatement,
    expr: N.Expression,
  ): N.ExpressionStatement {
    node.expression = expr;
    this.semicolon();
    return this.finishNode(node, "ExpressionStatement");
  }

  // Parse a semicolon-enclosed block of statements, handling `"use
  // strict"` declarations when `allowStrict` is true (used for
  // function bodies).

  parseBlock(allowDirectives?: boolean): N.BlockStatement {
    const node = this.startNode();
    this.expect(tt.braceL);
    this.parseBlockBody(node, allowDirectives, false, tt.braceR);
    return this.finishNode(node, "BlockStatement");
  }

  isValidDirective(stmt: N.Statement): boolean {
    return (
      stmt.type === "ExpressionStatement" &&
      stmt.expression.type === "StringLiteral" &&
      !stmt.expression.extra.parenthesized
    );
  }

  parseBlockBody(
    node: N.BlockStatementLike,
    allowDirectives: ?boolean,
    topLevel: boolean,
    end: TokenType,
  ): void {
    const body = (node.body = []);
    const directives = (node.directives = []);
    this.parseBlockOrModuleBlockBody(
      body,
      allowDirectives ? directives : undefined,
      topLevel,
      end,
    );
  }

  // Undefined directives means that directives are not allowed.
  parseBlockOrModuleBlockBody(
    body: N.Statement[],
    directives: ?(N.Directive[]),
    topLevel: boolean,
    end: TokenType,
  ): void {
    let parsedNonDirective = false;
    let oldStrict;
    let octalPosition;

    while (!this.eat(end)) {
      if (!parsedNonDirective && this.state.containsOctal && !octalPosition) {
        octalPosition = this.state.octalPosition;
      }

      const stmt = this.parseStatement(null, topLevel);

      if (directives && !parsedNonDirective && this.isValidDirective(stmt)) {
        const directive = this.stmtToDirective(stmt);
        directives.push(directive);

        if (oldStrict === undefined && directive.value.value === "use strict") {
          oldStrict = this.state.strict;
          this.setStrict(true);

          if (octalPosition) {
            this.raise(octalPosition, "Octal literal in strict mode");
          }
        }

        continue;
      }

      parsedNonDirective = true;
      body.push(stmt);
    }

    if (oldStrict === false) {
      this.setStrict(false);
    }
  }

  // Parse a regular `for` loop. The disambiguation code in
  // `parseStatement` will already have parsed the init statement or
  // expression.

  parseFor(
    node: N.ForStatement,
    init: ?(N.VariableDeclaration | N.Expression),
  ): N.ForStatement {
    node.init = init;
    this.expect(tt.semi);
    node.test = this.match(tt.semi) ? null : this.parseExpression();
    this.expect(tt.semi);
    node.update = this.match(tt.parenR) ? null : this.parseExpression();
    this.expect(tt.parenR);

    node.body =
      // For the smartPipelines plugin: Disable topic references from outer
      // contexts within the loop body. They are permitted in test expressions,
      // outside of the loop body.
      this.withTopicForbiddingContext(() =>
        // Parse the loop body.
        this.parseStatement("for"),
      );

    this.state.labels.pop();

    return this.finishNode(node, "ForStatement");
  }

  // Parse a `for`/`in` and `for`/`of` loop, which are almost
  // same from parser's perspective.

  parseForIn(
    node: N.ForInOf,
    init: N.VariableDeclaration,
    awaitAt: number,
  ): N.ForInOf {
    const type = this.match(tt._in) ? "ForInStatement" : "ForOfStatement";
    if (awaitAt > -1) {
      this.eatContextual("of");
    } else {
      this.next();
    }
    if (type === "ForOfStatement") {
      node.await = awaitAt > -1;
    }
    node.left = init;
    node.right = this.parseExpression();
    this.expect(tt.parenR);

    node.body =
      // For the smartPipelines plugin:
      // Disable topic references from outer contexts within the loop body.
      // They are permitted in test expressions, outside of the loop body.
      this.withTopicForbiddingContext(() =>
        // Parse loop body.
        this.parseStatement("for"),
      );

    this.state.labels.pop();

    return this.finishNode(node, type);
  }

  // Parse a list of variable declarations.

  parseVar(
    node: N.VariableDeclaration,
    isFor: boolean,
    kind: "var" | "let" | "const",
  ): N.VariableDeclaration {
    const declarations = (node.declarations = []);
    const isTypescript = this.hasPlugin("typescript");
    node.kind = kind;
    for (;;) {
      const decl = this.startNode();
      this.parseVarId(decl, kind);
      if (this.eat(tt.eq)) {
        decl.init = this.parseMaybeAssign(isFor);
      } else {
        if (
          kind === "const" &&
          !(this.match(tt._in) || this.isContextual("of"))
        ) {
          // `const` with no initializer is allowed in TypeScript.
          // It could be a declaration like `const x: number;`.
          if (!isTypescript) {
            this.unexpected();
          }
        } else if (
          decl.id.type !== "Identifier" &&
          !(isFor && (this.match(tt._in) || this.isContextual("of")))
        ) {
          this.raise(
            this.state.lastTokEnd,
            "Complex binding patterns require an initialization value",
          );
        }
        decl.init = null;
      }
      declarations.push(this.finishNode(decl, "VariableDeclarator"));
      if (!this.eat(tt.comma)) break;
    }
    return node;
  }

  parseVarId(decl: N.VariableDeclarator, kind: "var" | "let" | "const"): void {
    if ((kind === "const" || kind === "let") && this.isContextual("let")) {
      this.unexpected(null, "let is disallowed as a lexically bound name");
    }
    decl.id = this.parseBindingAtom();
    this.checkLVal(decl.id, true, undefined, "variable declaration");
  }

  // Parse a function declaration or literal (depending on the
  // `isStatement` parameter).

  parseFunction<T: N.NormalFunction>(
    node: T,
    isStatement: boolean,
    allowExpressionBody?: boolean = false,
    isAsync?: boolean = false,
    optionalId?: boolean = false,
  ): T {
    const oldInFunc = this.state.inFunction;
    const oldInMethod = this.state.inMethod;
    const oldInAsync = this.state.inAsync;
    const oldInGenerator = this.state.inGenerator;
    const oldInClassProperty = this.state.inClassProperty;
    const oldYieldPos = this.state.yieldPos;
    const oldAwaitPos = this.state.awaitPos;
    this.state.inFunction = true;
    this.state.inMethod = false;
    this.state.inClassProperty = false;
    this.state.yieldPos = 0;
    this.state.awaitPos = 0;

    this.initFunction(node, isAsync);

    node.generator = this.eat(tt.star);

    if (isStatement && !optionalId && !this.match(tt.name)) {
      this.unexpected();
    }

    // When parsing function expression, the binding identifier is parsed
    // according to the rules inside the function.
    // e.g. (function* yield() {}) is invalid because "yield" is disallowed in
    // generators.
    // This isn't the case with function declarations: function* yield() {} is
    // valid because yield is parsed as if it was outside the generator.
    // Therefore, this.state.inGenerator is set before or after parsing the
    // function id according to the "isStatement" parameter.
    // The same applies to await & async functions.
    if (!isStatement) {
      this.state.inAsync = isAsync;
      this.state.inGenerator = node.generator;
    }
    if (this.match(tt.name)) {
      node.id = this.parseIdentifier();
    }
    if (isStatement) {
      this.state.inAsync = isAsync;
      this.state.inGenerator = node.generator;
    }

    this.parseFunctionParams(node);

    // For the smartPipelines plugin: Disable topic references from outer
    // contexts within the function body. They are permitted in test
    // expressions, outside of the function body.
    this.withTopicForbiddingContext(() => {
      // Parse the function body.
      this.parseFunctionBodyAndFinish(
        node,
        isStatement ? "FunctionDeclaration" : "FunctionExpression",
        allowExpressionBody,
      );
    });

    this.state.inFunction = oldInFunc;
    this.state.inMethod = oldInMethod;
    this.state.inAsync = oldInAsync;
    this.state.inGenerator = oldInGenerator;
    this.state.inClassProperty = oldInClassProperty;
    this.state.yieldPos = oldYieldPos;
    this.state.awaitPos = oldAwaitPos;

    return node;
  }

  parseFunctionParams(node: N.Function, allowModifiers?: boolean): void {
    const oldInParameters = this.state.inParameters;
    this.state.inParameters = true;

    this.expect(tt.parenL);
    node.params = this.parseBindingList(
      tt.parenR,
      /* allowEmpty */ false,
      allowModifiers,
    );

    this.state.inParameters = oldInParameters;
    this.checkYieldAwaitInDefaultParams();
  }

  // Parse a class declaration or literal (depending on the
  // `isStatement` parameter).

  parseClass<T: N.Class>(
    node: T,
    isStatement: /* T === ClassDeclaration */ boolean,
    optionalId?: boolean,
  ): T {
    this.next();
    this.takeDecorators(node);

    // A class definition is always strict mode code.
    const oldStrict = this.state.strict;
    this.state.strict = true;

    this.parseClassId(node, isStatement, optionalId);
    this.parseClassSuper(node);
    this.parseClassBody(node);

    this.state.strict = oldStrict;

    return this.finishNode(
      node,
      isStatement ? "ClassDeclaration" : "ClassExpression",
    );
  }

  isClassProperty(): boolean {
    return this.match(tt.eq) || this.match(tt.semi) || this.match(tt.braceR);
  }

  isClassMethod(): boolean {
    return this.match(tt.parenL);
  }

  isNonstaticConstructor(method: N.ClassMethod | N.ClassProperty): boolean {
    return (
      !method.computed &&
      !method.static &&
      (method.key.name === "constructor" || // Identifier
        method.key.value === "constructor") // String literal
    );
  }

  parseClassBody(node: N.Class): void {
    this.state.classLevel++;

    const state = { hadConstructor: false };
    let decorators: N.Decorator[] = [];
    const classBody: N.ClassBody = this.startNode();

    classBody.body = [];

    this.expect(tt.braceL);

    // For the smartPipelines plugin: Disable topic references from outer
    // contexts within the class body. They are permitted in test expressions,
    // outside of the class body.
    this.withTopicForbiddingContext(() => {
      while (!this.eat(tt.braceR)) {
        if (this.eat(tt.semi)) {
          if (decorators.length > 0) {
            this.raise(
              this.state.lastTokEnd,
              "Decorators must not be followed by a semicolon",
            );
          }
          continue;
        }

        if (this.match(tt.at)) {
          decorators.push(this.parseDecorator());
          continue;
        }

        const member = this.startNode();

        // steal the decorators if there are any
        if (decorators.length) {
          member.decorators = decorators;
          this.resetStartLocationFromNode(member, decorators[0]);
          decorators = [];
        }

        this.parseClassMember(classBody, member, state);

        if (
          member.kind === "constructor" &&
          member.decorators &&
          member.decorators.length > 0
        ) {
          this.raise(
            member.start,
            "Decorators can't be used with a constructor. Did you mean '@dec class { ... }'?",
          );
        }
      }
    });

    if (decorators.length) {
      this.raise(
        this.state.start,
        "You have trailing decorators with no method",
      );
    }

    node.body = this.finishNode(classBody, "ClassBody");

    this.state.classLevel--;
  }

  parseClassMember(
    classBody: N.ClassBody,
    member: N.ClassMember,
    state: { hadConstructor: boolean },
  ): void {
    let isStatic = false;
    const containsEsc = this.state.containsEsc;

    if (this.match(tt.name) && this.state.value === "static") {
      const key = this.parseIdentifier(true); // eats 'static'

      if (this.isClassMethod()) {
        const method: N.ClassMethod = (member: any);

        // a method named 'static'
        method.kind = "method";
        method.computed = false;
        method.key = key;
        method.static = false;
        this.pushClassMethod(
          classBody,
          method,
          false,
          false,
          /* isConstructor */ false,
        );
        return;
      } else if (this.isClassProperty()) {
        const prop: N.ClassProperty = (member: any);

        // a property named 'static'
        prop.computed = false;
        prop.key = key;
        prop.static = false;
        classBody.body.push(this.parseClassProperty(prop));
        return;
      } else if (containsEsc) {
        throw this.unexpected();
      }

      // otherwise something static
      isStatic = true;
    }

    this.parseClassMemberWithIsStatic(classBody, member, state, isStatic);
  }

  parseClassMemberWithIsStatic(
    classBody: N.ClassBody,
    member: N.ClassMember,
    state: { hadConstructor: boolean },
    isStatic: boolean,
  ) {
    const publicMethod: $FlowSubtype<N.ClassMethod> = member;
    const privateMethod: $FlowSubtype<N.ClassPrivateMethod> = member;
    const publicProp: $FlowSubtype<N.ClassMethod> = member;
    const privateProp: $FlowSubtype<N.ClassPrivateMethod> = member;

    const method: typeof publicMethod | typeof privateMethod = publicMethod;
    const publicMember: typeof publicMethod | typeof publicProp = publicMethod;

    member.static = isStatic;

    if (this.eat(tt.star)) {
      // a generator
      method.kind = "method";
      this.parseClassPropertyName(method);

      if (method.key.type === "PrivateName") {
        // Private generator method
        this.pushClassPrivateMethod(classBody, privateMethod, true, false);
        return;
      }

      if (this.isNonstaticConstructor(publicMethod)) {
        this.raise(publicMethod.key.start, "Constructor can't be a generator");
      }

      this.pushClassMethod(
        classBody,
        publicMethod,
        true,
        false,
        /* isConstructor */ false,
      );

      return;
    }

    const key = this.parseClassPropertyName(member);
    const isPrivate = key.type === "PrivateName";
    // Check the key is not a computed expression or string literal.
    const isSimple = key.type === "Identifier";

    this.parsePostMemberNameModifiers(publicMember);

    if (this.isClassMethod()) {
      method.kind = "method";

      if (isPrivate) {
        this.pushClassPrivateMethod(classBody, privateMethod, false, false);
        return;
      }

      // a normal method
      const isConstructor = this.isNonstaticConstructor(publicMethod);

      if (isConstructor) {
        publicMethod.kind = "constructor";

        if (publicMethod.decorators) {
          this.raise(
            publicMethod.start,
            "You can't attach decorators to a class constructor",
          );
        }

        // TypeScript allows multiple overloaded constructor declarations.
        if (state.hadConstructor && !this.hasPlugin("typescript")) {
          this.raise(key.start, "Duplicate constructor in the same class");
        }
        state.hadConstructor = true;
      }

      this.pushClassMethod(
        classBody,
        publicMethod,
        false,
        false,
        isConstructor,
      );
    } else if (this.isClassProperty()) {
      if (isPrivate) {
        this.pushClassPrivateProperty(classBody, privateProp);
      } else {
        this.pushClassProperty(classBody, publicProp);
      }
    } else if (isSimple && key.name === "async" && !this.isLineTerminator()) {
      // an async method
      const isGenerator = this.eat(tt.star);

      method.kind = "method";
      // The so-called parsed name would have been "async": get the real name.
      this.parseClassPropertyName(method);

      if (method.key.type === "PrivateName") {
        // private async method
        this.pushClassPrivateMethod(
          classBody,
          privateMethod,
          isGenerator,
          true,
        );
      } else {
        if (this.isNonstaticConstructor(publicMethod)) {
          this.raise(
            publicMethod.key.start,
            "Constructor can't be an async function",
          );
        }

        this.pushClassMethod(
          classBody,
          publicMethod,
          isGenerator,
          true,
          /* isConstructor */ false,
        );
      }
    } else if (
      isSimple &&
      (key.name === "get" || key.name === "set") &&
      !(this.match(tt.star) && this.isLineTerminator())
    ) {
      // `get\n*` is an uninitialized property named 'get' followed by a generator.
      // a getter or setter
      method.kind = key.name;
      // The so-called parsed name would have been "get/set": get the real name.
      this.parseClassPropertyName(publicMethod);

      if (method.key.type === "PrivateName") {
        // private getter/setter
        this.pushClassPrivateMethod(classBody, privateMethod, false, false);
      } else {
        if (this.isNonstaticConstructor(publicMethod)) {
          this.raise(
            publicMethod.key.start,
            "Constructor can't have get/set modifier",
          );
        }
        this.pushClassMethod(
          classBody,
          publicMethod,
          false,
          false,
          /* isConstructor */ false,
        );
      }

      this.checkGetterSetterParams(publicMethod);
    } else if (this.isLineTerminator()) {
      // an uninitialized class property (due to ASI, since we don't otherwise recognize the next token)
      if (isPrivate) {
        this.pushClassPrivateProperty(classBody, privateProp);
      } else {
        this.pushClassProperty(classBody, publicProp);
      }
    } else {
      this.unexpected();
    }
  }

  parseClassPropertyName(member: N.ClassMember): N.Expression | N.Identifier {
    const key = this.parsePropertyName(member);

    if (
      !member.computed &&
      member.static &&
      ((key: $FlowSubtype<N.Identifier>).name === "prototype" ||
        (key: $FlowSubtype<N.StringLiteral>).value === "prototype")
    ) {
      this.raise(
        key.start,
        "Classes may not have static property named prototype",
      );
    }

    if (key.type === "PrivateName" && key.id.name === "constructor") {
      this.raise(
        key.start,
        "Classes may not have a private field named '#constructor'",
      );
    }

    return key;
  }

  pushClassProperty(classBody: N.ClassBody, prop: N.ClassProperty) {
    // This only affects properties, not methods.
    if (this.isNonstaticConstructor(prop)) {
      this.raise(
        prop.key.start,
        "Classes may not have a non-static field named 'constructor'",
      );
    }
    classBody.body.push(this.parseClassProperty(prop));
  }

  pushClassPrivateProperty(
    classBody: N.ClassBody,
    prop: N.ClassPrivateProperty,
  ) {
    this.expectPlugin("classPrivateProperties", prop.key.start);
    classBody.body.push(this.parseClassPrivateProperty(prop));
  }

  pushClassMethod(
    classBody: N.ClassBody,
    method: N.ClassMethod,
    isGenerator: boolean,
    isAsync: boolean,
    isConstructor: boolean,
  ): void {
    classBody.body.push(
      this.parseMethod(
        method,
        isGenerator,
        isAsync,
        isConstructor,
        "ClassMethod",
      ),
    );
  }

  pushClassPrivateMethod(
    classBody: N.ClassBody,
    method: N.ClassPrivateMethod,
    isGenerator: boolean,
    isAsync: boolean,
  ): void {
    this.expectPlugin("classPrivateMethods", method.key.start);
    classBody.body.push(
      this.parseMethod(
        method,
        isGenerator,
        isAsync,
        /* isConstructor */ false,
        "ClassPrivateMethod",
      ),
    );
  }

  // Overridden in typescript.js
  parsePostMemberNameModifiers(
    // eslint-disable-next-line no-unused-vars
    methodOrProp: N.ClassMethod | N.ClassProperty,
  ): void {}

  // Overridden in typescript.js
  parseAccessModifier(): ?N.Accessibility {
    return undefined;
  }

  parseClassPrivateProperty(
    node: N.ClassPrivateProperty,
  ): N.ClassPrivateProperty {
    const oldInMethod = this.state.inMethod;
    this.state.inMethod = false;
    this.state.inClassProperty = true;
    node.value = this.eat(tt.eq) ? this.parseMaybeAssign() : null;
    this.semicolon();
    this.state.inClassProperty = false;
    this.state.inMethod = oldInMethod;
    return this.finishNode(node, "ClassPrivateProperty");
  }

  parseClassProperty(node: N.ClassProperty): N.ClassProperty {
    if (!node.typeAnnotation) {
      this.expectPlugin("classProperties");
    }

    const oldInMethod = this.state.inMethod;
    this.state.inMethod = false;
    this.state.inClassProperty = true;

    if (this.match(tt.eq)) {
      this.expectPlugin("classProperties");
      this.next();
      node.value = this.parseMaybeAssign();
    } else {
      node.value = null;
    }
    this.semicolon();
    this.state.inClassProperty = false;
    this.state.inMethod = oldInMethod;

    return this.finishNode(node, "ClassProperty");
  }

  parseClassId(
    node: N.Class,
    isStatement: boolean,
    optionalId: ?boolean,
  ): void {
    if (this.match(tt.name)) {
      node.id = this.parseIdentifier();
    } else {
      if (optionalId || !isStatement) {
        node.id = null;
      } else {
        this.unexpected(null, "A class name is required");
      }
    }
  }

  parseClassSuper(node: N.Class): void {
    node.superClass = this.eat(tt._extends) ? this.parseExprSubscripts() : null;
  }

  // Parses module export declaration.

  parseExport(node: N.Node): N.AnyExport {
    const hasDefault = this.maybeParseExportDefaultSpecifier(node);
    const parseAfterDefault = !hasDefault || this.eat(tt.comma);
    const hasStar = parseAfterDefault && this.eatExportStar(node);
    const hasNamespace =
      hasStar && this.maybeParseExportNamespaceSpecifier(node);
    const parseAfterNamespace =
      parseAfterDefault && (!hasNamespace || this.eat(tt.comma));
    const isFromRequired = hasDefault || hasStar;

    if (hasStar && !hasNamespace) {
      if (hasDefault) this.unexpected();
      this.parseExportFrom(node, true);

      return this.finishNode(node, "ExportAllDeclaration");
    }

    const hasSpecifiers = this.maybeParseExportNamedSpecifiers(node);

    if (
      (hasDefault && parseAfterDefault && !hasStar && !hasSpecifiers) ||
      (hasNamespace && parseAfterNamespace && !hasSpecifiers)
    ) {
      throw this.unexpected(null, tt.braceL);
    }

    let hasDeclaration;
    if (isFromRequired || hasSpecifiers) {
      hasDeclaration = false;
      this.parseExportFrom(node, isFromRequired);
    } else {
      hasDeclaration = this.maybeParseExportDeclaration(node);
    }

    if (isFromRequired || hasSpecifiers || hasDeclaration) {
      this.checkExport(node, true);
      return this.finishNode(node, "ExportNamedDeclaration");
    }

    if (this.eat(tt._default)) {
      // export default ...
      node.declaration = this.parseExportDefaultExpression();
      this.checkExport(node, true, true);

      return this.finishNode(node, "ExportDefaultDeclaration");
    }

    throw this.unexpected(null, tt.braceL);
  }

  // eslint-disable-next-line no-unused-vars
  eatExportStar(node: N.Node): boolean {
    return this.eat(tt.star);
  }

  maybeParseExportDefaultSpecifier(node: N.Node): boolean {
    if (this.isExportDefaultSpecifier()) {
      // export defaultObj ...
      this.expectPlugin("exportDefaultFrom");
      const specifier = this.startNode();
      specifier.exported = this.parseIdentifier(true);
      node.specifiers = [this.finishNode(specifier, "ExportDefaultSpecifier")];
      return true;
    }
    return false;
  }

  maybeParseExportNamespaceSpecifier(node: N.Node): boolean {
    if (this.isContextual("as")) {
      if (!node.specifiers) node.specifiers = [];
      this.expectPlugin("exportNamespaceFrom");

      const specifier = this.startNodeAt(
        this.state.lastTokStart,
        this.state.lastTokStartLoc,
      );

      this.next();

      specifier.exported = this.parseIdentifier(true);
      node.specifiers.push(
        this.finishNode(specifier, "ExportNamespaceSpecifier"),
      );
      return true;
    }
    return false;
  }

  maybeParseExportNamedSpecifiers(node: N.Node): boolean {
    if (this.match(tt.braceL)) {
      if (!node.specifiers) node.specifiers = [];
      node.specifiers.push(...this.parseExportSpecifiers());

      node.source = null;
      node.declaration = null;

      return true;
    }
    return false;
  }

  maybeParseExportDeclaration(node: N.Node): boolean {
    if (this.shouldParseExportDeclaration()) {
      if (this.isContextual("async")) {
        const next = this.lookahead();

        // export async;
        if (next.type !== tt._function) {
          this.unexpected(next.start, `Unexpected token, expected "function"`);
        }
      }

      node.specifiers = [];
      node.source = null;
      node.declaration = this.parseExportDeclaration(node);

      return true;
    }
    return false;
  }

  isAsyncFunction() {
    if (!this.isContextual("async")) return false;

    const { input, pos, length } = this.state;

    skipWhiteSpace.lastIndex = pos;
    const skip = skipWhiteSpace.exec(input);

    if (!skip || !skip.length) return false;

    const next = pos + skip[0].length;

    return (
      !lineBreak.test(input.slice(pos, next)) &&
      input.slice(next, next + 8) === "function" &&
      (next + 8 === length || !isIdentifierChar(input.charCodeAt(next + 8)))
    );
  }

  parseExportDefaultExpression(): N.Expression | N.Declaration {
    const expr = this.startNode();

    const isAsync = this.isAsyncFunction();

    if (this.eat(tt._function) || isAsync) {
      if (isAsync) {
        this.eatContextual("async");
        this.expect(tt._function);
      }

      return this.parseFunction(expr, true, false, isAsync, true);
    } else if (this.match(tt._class)) {
      return this.parseClass(expr, true, true);
    } else if (this.match(tt.at)) {
      if (
        this.hasPlugin("decorators") &&
        this.getPluginOption("decorators", "decoratorsBeforeExport")
      ) {
        this.unexpected(
          this.state.start,
          "Decorators must be placed *before* the 'export' keyword." +
            " You can set the 'decoratorsBeforeExport' option to false to use" +
            " the 'export @decorator class {}' syntax",
        );
      }
      this.parseDecorators(false);
      return this.parseClass(expr, true, true);
    } else if (this.match(tt._const) || this.match(tt._var) || this.isLet()) {
      return this.raise(
        this.state.start,
        "Only expressions, functions or classes are allowed as the `default` export.",
      );
    } else {
      const res = this.parseMaybeAssign();
      this.semicolon();
      return res;
    }
  }

  // eslint-disable-next-line no-unused-vars
  parseExportDeclaration(node: N.ExportNamedDeclaration): ?N.Declaration {
    return this.parseStatement(null);
  }

  isExportDefaultSpecifier(): boolean {
    if (this.match(tt.name)) {
      return this.state.value !== "async" && this.state.value !== "let";
    }

    if (!this.match(tt._default)) {
      return false;
    }

    const lookahead = this.lookahead();
    return (
      lookahead.type === tt.comma ||
      (lookahead.type === tt.name && lookahead.value === "from")
    );
  }

  parseExportFrom(node: N.ExportNamedDeclaration, expect?: boolean): void {
    if (this.eatContextual("from")) {
      node.source = this.parseImportSource();
      this.checkExport(node);
    } else {
      if (expect) {
        this.unexpected();
      } else {
        node.source = null;
      }
    }

    this.semicolon();
  }

  shouldParseExportDeclaration(): boolean {
    if (this.match(tt.at)) {
      this.expectOnePlugin(["decorators", "decorators-legacy"]);
      if (this.hasPlugin("decorators")) {
        if (this.getPluginOption("decorators", "decoratorsBeforeExport")) {
          this.unexpected(
            this.state.start,
            "Decorators must be placed *before* the 'export' keyword." +
              " You can set the 'decoratorsBeforeExport' option to false to use" +
              " the 'export @decorator class {}' syntax",
          );
        } else {
          return true;
        }
      }
    }

    return (
      this.state.type.keyword === "var" ||
      this.state.type.keyword === "const" ||
      this.state.type.keyword === "function" ||
      this.state.type.keyword === "class" ||
      this.isLet() ||
      this.isAsyncFunction()
    );
  }

  checkExport(
    node: N.ExportNamedDeclaration,
    checkNames: ?boolean,
    isDefault?: boolean,
  ): void {
    if (checkNames) {
      // Check for duplicate exports
      if (isDefault) {
        // Default exports
        this.checkDuplicateExports(node, "default");
      } else if (node.specifiers && node.specifiers.length) {
        // Named exports
        for (const specifier of node.specifiers) {
          this.checkDuplicateExports(specifier, specifier.exported.name);
        }
      } else if (node.declaration) {
        // Exported declarations
        if (
          node.declaration.type === "FunctionDeclaration" ||
          node.declaration.type === "ClassDeclaration"
        ) {
          const id = node.declaration.id;
          if (!id) throw new Error("Assertion failure");

          this.checkDuplicateExports(node, id.name);
        } else if (node.declaration.type === "VariableDeclaration") {
          for (const declaration of node.declaration.declarations) {
            this.checkDeclaration(declaration.id);
          }
        }
      }
    }

    const currentContextDecorators = this.state.decoratorStack[
      this.state.decoratorStack.length - 1
    ];
    if (currentContextDecorators.length) {
      const isClass =
        node.declaration &&
        (node.declaration.type === "ClassDeclaration" ||
          node.declaration.type === "ClassExpression");
      if (!node.declaration || !isClass) {
        throw this.raise(
          node.start,
          "You can only use decorators on an export when exporting a class",
        );
      }
      this.takeDecorators(node.declaration);
    }
  }

  checkDeclaration(node: N.Pattern | N.ObjectProperty): void {
    if (node.type === "Identifier") {
      this.checkDuplicateExports(node, node.name);
    } else if (node.type === "ObjectPattern") {
      for (const prop of node.properties) {
        this.checkDeclaration(prop);
      }
    } else if (node.type === "ArrayPattern") {
      for (const elem of node.elements) {
        if (elem) {
          this.checkDeclaration(elem);
        }
      }
    } else if (node.type === "ObjectProperty") {
      this.checkDeclaration(node.value);
    } else if (node.type === "RestElement") {
      this.checkDeclaration(node.argument);
    } else if (node.type === "AssignmentPattern") {
      this.checkDeclaration(node.left);
    }
  }

  checkDuplicateExports(
    node:
      | N.Identifier
      | N.ExportNamedDeclaration
      | N.ExportSpecifier
      | N.ExportDefaultSpecifier,
    name: string,
  ): void {
    if (this.state.exportedIdentifiers.indexOf(name) > -1) {
      throw this.raise(
        node.start,
        name === "default"
          ? "Only one default export allowed per module."
          : `\`${name}\` has already been exported. Exported identifiers must be unique.`,
      );
    }
    this.state.exportedIdentifiers.push(name);
  }

  // Parses a comma-separated list of module exports.

  parseExportSpecifiers(): Array<N.ExportSpecifier> {
    const nodes = [];
    let first = true;
    let needsFrom;

    // export { x, y as z } [from '...']
    this.expect(tt.braceL);

    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else {
        this.expect(tt.comma);
        if (this.eat(tt.braceR)) break;
      }

      const isDefault = this.match(tt._default);
      if (isDefault && !needsFrom) needsFrom = true;

      const node = this.startNode();
      node.local = this.parseIdentifier(isDefault);
      node.exported = this.eatContextual("as")
        ? this.parseIdentifier(true)
        : node.local.__clone();
      nodes.push(this.finishNode(node, "ExportSpecifier"));
    }

    // https://github.com/ember-cli/ember-cli/pull/3739
    if (needsFrom && !this.isContextual("from")) {
      this.unexpected();
    }

    return nodes;
  }

  // Parses import declaration.

  parseImport(node: N.Node): N.AnyImport {
    // import '...'
    node.specifiers = [];
    if (!this.match(tt.string)) {
      const hasDefault = this.maybeParseDefaultImportSpecifier(node);
      const parseNext = !hasDefault || this.eat(tt.comma);
      const hasStar = parseNext && this.maybeParseStarImportSpecifier(node);
      if (parseNext && !hasStar) this.parseNamedImportSpecifiers(node);
      this.expectContextual("from");
    }
    node.source = this.parseImportSource();
    this.semicolon();
    return this.finishNode(node, "ImportDeclaration");
  }

  parseImportSource(): N.StringLiteral {
    if (!this.match(tt.string)) this.unexpected();
    return this.parseExprAtom();
  }

  // eslint-disable-next-line no-unused-vars
  shouldParseDefaultImport(node: N.ImportDeclaration): boolean {
    return this.match(tt.name);
  }

  parseImportSpecifierLocal(
    node: N.ImportDeclaration,
    specifier: N.Node,
    type: string,
    contextDescription: string,
  ): void {
    specifier.local = this.parseIdentifier();
    this.checkLVal(specifier.local, true, undefined, contextDescription);
    node.specifiers.push(this.finishNode(specifier, type));
  }

  maybeParseDefaultImportSpecifier(node: N.ImportDeclaration): boolean {
    if (this.shouldParseDefaultImport(node)) {
      // import defaultObj, { x, y as z } from '...'
      this.parseImportSpecifierLocal(
        node,
        this.startNode(),
        "ImportDefaultSpecifier",
        "default import specifier",
      );
      return true;
    }
    return false;
  }

  maybeParseStarImportSpecifier(node: N.ImportDeclaration): boolean {
    if (this.match(tt.star)) {
      const specifier = this.startNode();
      this.next();
      this.expectContextual("as");

      this.parseImportSpecifierLocal(
        node,
        specifier,
        "ImportNamespaceSpecifier",
        "import namespace specifier",
      );
      return true;
    }
    return false;
  }

  parseNamedImportSpecifiers(node: N.ImportDeclaration) {
    let first = true;
    this.expect(tt.braceL);
    while (!this.eat(tt.braceR)) {
      if (first) {
        first = false;
      } else {
        // Detect an attempt to deep destructure
        if (this.eat(tt.colon)) {
          this.unexpected(
            null,
            "ES2015 named imports do not destructure. " +
              "Use another statement for destructuring after the import.",
          );
        }

        this.expect(tt.comma);
        if (this.eat(tt.braceR)) break;
      }

      this.parseImportSpecifier(node);
    }
  }

  parseImportSpecifier(node: N.ImportDeclaration): void {
    const specifier = this.startNode();
    specifier.imported = this.parseIdentifier(true);
    if (this.eatContextual("as")) {
      specifier.local = this.parseIdentifier();
    } else {
      this.checkReservedWord(
        specifier.imported.name,
        specifier.start,
        true,
        true,
      );
      specifier.local = specifier.imported.__clone();
    }
    this.checkLVal(specifier.local, true, undefined, "import specifier");
    node.specifiers.push(this.finishNode(specifier, "ImportSpecifier"));
  }
}
