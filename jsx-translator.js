"use strict";

/*****************************************************************************
This program extracts translateable messages from JSX files,
sanitizes them for showing to translators, reconstitutes the sanitized
translations based on the original input, and generates JSX files
with the messages replaced with translated ones. Messages can be
not just strings but JSX elements.

Most of the code here is functions on ASTs, which may be of a whole program
or only a single expression. Some of the functions only operate on ASTs
representing particular kinds of expressions, while others work on any AST.
The AST format is documented here:
https://developer.mozilla.org/en-US/docs/Mozilla/Projects/SpiderMonkey/Parser_API
The JSX extensions are not documented; they just come from esprima-fb.


There are five important processes:
* Finding messages within a file
* Sanitizing a message for presenting to the translator
* Reconstituting the sanitized parts of a translated message
* Printing and unprinting JSX elements and string literals
* Translating a whole file


Finding messages:

There are two forms of messages: string literals and JSX elements.
String literals are marked with a special identity function:
    i18n("Hello, world!")
JSX elements are marked with a special React component:
    <I18N>Hello, <em>world!</em></I18N>


Sanitizing:

We want translators to see some markup, so that they can make necessary
changes, but other sorts of markup are confusing and irrelevant to them,
and dangerous for them to edit. And they certainly shouldn't see JavaScript
expressions inside curly-braces. Therefore:

1) Sanitization removes attributes not listed in
   allowedAttributesByComponentName.
2) The only expressions allowed in messages are identifiers and simple
   member expressions (e.g. "foo.bar.baz").


Reconstituting:

Reconstituting is the process of putting back what was taken away during
sanitization. The process starts with the translator's translation and pulls
out details from the original; thus, the translator's version determines the
structure of the markup, while the original only determines the values of
expressions and elided attributes. During reconstitution, checks can be
performed to make sure that the translator hasn't deviated too much from
the original.

When we elide attributes from an element, we need to know
which element in the translation to re-attach those attributes to. Since
translators can add and remove elements, the only general way to know where to
put the attributes is to give that element a special designation:

<I18N><a:my-link href="example.com" target="_blank">Example</a:my-link></I18N>
        ^^^^^^^^                                              ^^^^^^^^
When sanitized, this produces the message:

<a:my-link href="example.com">Example</a:my-link>

Note that target="_blank" is missing. Now the translator can rearrange at will:

<i>Click me: <a:my-link href="example.fr">Example</a:my-link></i>

Under reconstitution, the elided attribute is put back in and the
designation removed:

<I18N><i>Click me: <a href="example.fr" target="_blank">Example</a></i></I18N>

There is an alternative syntax if you want your untranslated sources to be
executable, since namespaces would interfere with that. You can say:

<a i18n-designation="foo"></a>

which will be shown to the translator as:

<a:foo></a:foo>


Printing and unprinting:

Most of the process works on ASTs, but we need to turn those ASTs into strings
to show the translator, and parse the translation back into an AST. However,
the strings we want to show the translator are not exactly the generated code
of any single AST node, so we have to do a small extra step when generating
and parsing.

For string messages, we want to show them unquoted, and so we must also requote
them before parsing.

For JSX messages, we don't want to show the outer <I18N> tag, so we generate
each of the message's children and concatenate them. During parsing, we
surround the string with <I18N> tags and then parse it.


Translating a message:

To translate a whole file, we first find the keypath of every message in the
file. (A keypath is a sequence of keys and array indices that can be used to
select a node out of the AST.)

*****************************************************************************/

/*
NOTES:

assertion:
list (with rep) of capitalized component names must be the same in original and translated
Ensure can't go from self-closing to not or vice-versa in translation.
Ensure no tag with designation has member expression for tag name.

TODO:
- Bail out if the translation has non-safe attributes; refactor attribute functions.
- spread attribute
- Various heuristics for omitting i18n-designation.
- strip leading whitespace? -- rules appear complicated
*/

Error.stackTraceLimit = Infinity;

var esprima = require('esprima-fb');
var escodegen = require('escodegen');
var I = require('immutable');

/*
    These attributes are shown to translators and may be inserted
    and modified by translators:
*/
var allowedAttributesByComponentName = {
    'a': ['href'],
}


// ==================================
// UTILITIES
// ==================================

function identity(x) { return x; }

function isFunction(thing) {
    return typeof thing == 'function' || false;
}

function isString(thing) {
    return typeof thing == 'string' || false;
}

function duplicatedValues(list) {
    var dupes = [];
    var seen = [];
    list.forEach(x => {
        if (~seen.indexOf(x) && !~dupes.indexOf(x)) dupes.push(x);
        else seen.push(x);
    });
    return I.Set(dupes);
}

function InputError(description) {
    return I.Map({
        isInputError: true,
        description: description
    });
}

function isInputError(e) {
    return I.Map.isMap(e) && e.get('isInputError');
}


// ==================================
// AST UTILITIES
// ==================================

function parse(src) {
    return I.fromJS(esprima.parse(src, {loc:true}));
}

function parseFragment(src) {
    return parse(src).getIn(['body', 0, 'expression']);
}

function generate(ast) {
    return escodegen.generate(ast.toJS());
}

function generateOpening(jsxExpressionAst) {
    return generate(jsxExpressionAst.get('openingElement'));
}

function makeLiteralExpressionAst(value) {
    return parseFragment(value);
}

function componentNameAst(jsxElementAst) {
    var nameAst = jsxElementAst.getIn(['openingElement', 'name']);
    var type = nameAst.get('type');

    if (type === 'XJSNamespacedName') {
        // The component is of the form <name:designation>
        return nameAst.get('namespace');
    }
    else if (type === 'XJSIdentifier' || type === 'XJSMemberExpression') {
        // The component is of the form <name> or <namey.mcnamerson>
        return nameAst;
    }
    else {
        throw new Error(`Unknown component name type ${type} for component ${generateOpening(jsxElementAst)}`);
    }    
}

function componentName(jsxElementAst) {
    return generate(componentNameAst(jsxElementAst));
}

function componentDesignation(jsxElementAst) {
    var nameAst = jsxElementAst.getIn(['openingElement', 'name']);
    var type = nameAst.get('type');

    if (type === 'XJSNamespacedName') {
        // The component is of the form <name:designation>
        return generate(nameAst.get('name'));
    }
    else {
        // The component has an i18n-designation attribute or else has no designation.
        return attributeWithName(jsxElementAst, 'i18n-designation');
    }
}

function rewriteDesignationToNamespaceSyntax (jsxElementAst) {
    var name = componentName(jsxElementAst);
    var designation = componentDesignation(jsxElementAst);
    var attribute = attributeWithName(jsxElementAst, 'i18n-designation');
    if (designation && attribute) {
        var namespacedName = I.fromJS({
            type: 'XJSNamespacedName',
            name: {
                type: 'XJSIdentifier',
                name: designation
            },
            namespace: {
                type: 'XJSIdentifier',
                name: name
            }
        });
        var withNamespace = setJsxElementName(jsxElementAst, namespacedName);
        return updateAttributes(withNamespace, attributes =>
            attributes.filterNot(a => attributeName(a) === 'i18n-designation'))
    }
    else {
        return jsxElementAst;
    }
}

function removeDesignation(jsxElementAst) {
    var renamed = setJsxElementName(jsxElementAst,
            componentNameAst(jsxElementAst));
    return removeAttributeWithName(renamed, 'i18n-designation');
}

function setJsxElementName (jsxElementAst, nameAst) {
    if (jsxElementAst.getIn(['openingElement', 'selfClosing'])) {
        return jsxElementAst.setIn(['openingElement', 'name'], nameAst);
    }
    else {
        return jsxElementAst.setIn(['openingElement', 'name'], nameAst)
                            .setIn(['closingElement', 'name'], nameAst);
    }
}

function attributeMap(attributes) {
    return I.Map(attributes.map(a => [a.get('name'), a.get('value')]));
}

function attributesFromMap(attributes) {
    return I.List(attributes.map((v,k) => I.Map({
        type: 'XJSAttribute',
        name: k,
        value: v
    })).valueSeq());
}

function attributes(jsxElementAst) {
    return jsxElementAst.getIn(['openingElement', 'attributes']);
}

function updateAttributes(jsxElementAst, f) {
    return jsxElementAst.updateIn(['openingElement', 'attributes'], f);
}

function hasUnsafeAttributes(jsxElementAst) {
    var name = componentName(jsxElementAst);
    return attributes(jsxElementAst).some(a => !attributeIsSafe(name, a));
}

function withSafeAttributesOnly(jsxElementAst) {
    var name = componentName(jsxElementAst);
    return updateAttributes(jsxElementAst, attributes =>
        attributes.filter(a => attributeIsSafe(name, a)));
}

function attributeIsSafe(componentName, attributeAst) {
    if (!componentName) { throw new Error("Component name missing."); }
    var forComponent = allowedAttributesByComponentName[componentName] || [];
    return -1 !== forComponent.indexOf(attributeName(attributeAst));
}

function attributeName(attributeAst) {
    return attributeAst.getIn(['name', 'name'])
}

function attributeValue(attributeAst) {
    return attributeAst.getIn(['value', 'value']);
}

function attributeWithName(jsxElementAst, name) {
    var a = attributes(jsxElementAst)
        .filter(attrib => attributeName(attrib) === name)
        .first();
    return a && attributeValue(a);
}

function removeAttributeWithName(jsxElementAst, name) {
    return jsxElementAst.updateIn(['openingElement', 'attributes'],
        attributes => attributes
        .filterNot(attrib => attributeName(attrib) === name));
}


// ==================================
// VALIDATE
// ==================================


function validateMessage(ast) {
    var _ = ({
        'CallExpression': validateCallExpression,
        'XJSElement': validateJsxElement,
        'XJSExpressionContainer': validateJsxExpressionContainer,
    }[ast.get('type')] || identity)(ast);
    return ast;
}

function validateCallExpression(ast) {
    // The only valid call expression is the outer message marker:
    if (!isStringMarker(ast)) {
        throw new Error("Internal error: tried to sanitize call expression: " + generate(ast));
    }
}

function validateJsxElement(ast) {
    // Throws if definitions are duplicated:
    namedExpressionDefinitions(ast);

    if (hasUnsafeAttributes(ast) && ! componentDesignation(ast)) {
        throw new InputError("Element needs a designation: " + generateOpening(ast));
    }

    // Disallow direct nesting of message marker tags:
    if (isElementMarker(ast) && ast.get('children').some(isElementMarker)) {
        throw new InputError("Don't directly nest <I18N> tags: " + generate(ast));
    }

    ast.get('children').forEach(validateMessage);
}

function validateJsxExpressionContainer(ast) {
    var expression = ast.get('expression');
    if (! isNamedExpression(expression)) {
        throw new InputError("Message contains a non-named expression: " + generate(ast));
    }
}


// ==================================
// VALIDATE TRANSLATIONS
// ==================================

function validateTranslation(translation, original) {
    // Throws if definitions are duplicated:
    namedExpressionDefinitions(translation);

    return translation;
}


// ==================================
// SANITIZE
// ==================================

function sanitize(ast) {
    return {
        'Literal': identity,
        'CallExpression': identity,
        'XJSElement': sanitizeJsxElement,
        'XJSExpressionContainer': sanitizeJsxExpressionContainer,
        'XJSEmptyExpression': identity,
    }[ast.get('type')](ast);
}

function sanitizeJsxElement (ast) {
    return withSafeAttributesOnly(rewriteDesignationToNamespaceSyntax(ast))
        .update('children', children => children.map(sanitize));
}

function sanitizeJsxExpressionContainer (ast) {
    // Validation ensures expression is a named expression.
    var [name, expression] = nameAndExpressionForNamedExpression(ast.get('expression'));
    return ast.set('expression', makeLiteralExpressionAst(name));
}

function nameAndExpressionForNamedExpression(ast) {
    return [generate(ast), ast];
}


// ==================================
// RECONSTITUTE
// ==================================

// Return translatedAst with named expressions and elided
// attributes put back in based on originalAst.
function reconstitute(translatedAst, originalAst) {
    return _reconstitute(translatedAst, namedExpressionDefinitions(originalAst));
}

function _reconstitute(translatedAst, definitions) {
    return {
        'Identifier': identity, // FIXME what else should be here? why not in sanitize?
        'Literal': identity,
        'XJSElement': reconstituteJsxElement,
        'XJSExpressionContainer': reconstituteJsxExpressionContainer,
        'XJSEmptyExpression': identity
    }[translatedAst.get('type')](translatedAst, definitions);
}


function reconstituteJsxElement(translatedAst, definitions) {
    if (hasUnsafeAttributes(translatedAst)) {
        throw new InputError("Translation includes unsafe attribute: " + generateOpening(translatedAst));
    }

    var result;
    var designation = componentDesignation(translatedAst);
    if (designation) {
        var originalAttributes = definitions.get(designation);
        if (!originalAttributes) { throw new InputError("Translation contains designation '" + designation + "', which is not in the original."); }

        result = updateAttributes(translatedAst,
            translationAttributes => attributesFromMap(
                attributeMap(originalAttributes).merge(
                attributeMap(translationAttributes))));

        result = removeDesignation(result);
    } else {
        result = translatedAst;
    }

    return result.update('children', children =>
        children.map(child => _reconstitute(child, definitions)));
}

function reconstituteJsxExpressionContainer(translatedAst, definitions) {
    var expr = translatedAst.get('expression');
    if (!isNamedExpression(expr)) throw new InputError("Translated message has JSX expression that isn't a placeholder name: " + generate(translatedAst));
    var definition = definitions.get(generate(expr));
    if (!definition) throw new InputError("Translated message has a JSX expression whose name doesn't exist in the original: " + generate(translatedAst));
    return translatedAst.set('expression', definition);
}


// ==================================
// NAMED EXPRESSIONS, FINDING DEFINITIONS OF
// ==================================

function namedExpressionDefinitions(ast) {
    var listOfPairs = _namedExpressionDefinitions(ast);
    var names = listOfPairs.map(p => p.first());
    var dupes = duplicatedValues(names);
    if (dupes.size != 0) {
        throw new InputError("Message has two named expressions with the same name: " + dupes.join(", "));
    } else {
        return I.Map(listOfPairs.map(x => x.toArray()));
    }
}

function _namedExpressionDefinitions(ast) {
    return ({
        'XJSElement': namedExpressionDefinitionsInJsxElement,
        'XJSExpressionContainer': namedExpressionDefinitionsInJsxExpressionContainer
    }[ast.get('type')] || () => I.List())(ast);
}

function namedExpressionDefinitionsInJsxElement(ast) {
    var hiddenAttributes = attributes(ast)
        .filterNot(attrib => attributeIsSafe(componentName(ast), attrib));

    var attributeDefinition;
    if (hiddenAttributes.size == 0) {
        attributeDefinition = I.List();
    } else {
        var designation = componentDesignation(ast);
        if (!designation) throw new InputError("Element needs a designation: " + generateOpening(ast));
        attributeDefinition = I.List([I.List([designation, hiddenAttributes])]);
    }

    return attributeDefinition.concat(
        ast.get('children').flatMap(_namedExpressionDefinitions));
}

function namedExpressionDefinitionsInJsxExpressionContainer(ast) {
    if (isNamedExpression(ast.get('expression'))) {    
        var definition = nameAndExpressionForNamedExpression(ast.get('expression'));
        return I.fromJS([definition]);
    } else {
        return I.List();
    }
}



// ==================================
// FINDING
// ==================================

function matches(ast, pattern) {
    if ( I.Map.isMap(ast) && I.Map.isMap(pattern) ) {
        return pattern.every((v,k) => matches(ast.get(k), v));
    } else if (isFunction(pattern)) {
        return pattern(ast);
    } else {
        return I.is(pattern, ast);
    }
}

function matcher(pattern) {
    var Ipattern = I.fromJS(pattern);
    return value => matches(value, Ipattern);
}

var isStringMarker = matcher({
    type: "CallExpression",
    callee: {
        type: "Identifier",
        name: "i18n"
    }
});

var isElementMarker = matcher({
    type: "XJSElement",
    openingElement: {
        type: "XJSOpeningElement",
        selfClosing: false,
        name: {
            type: "XJSIdentifier",
            name: "I18N"
        }
    }    
});

function isMarker (ast) {
    return isStringMarker(ast) || isElementMarker(ast);
}

var isStringLiteral = matcher({
    type: "Literal",
    value: isString
});

var isJsxElement = matcher({
    type: "XJSElement"
});

var isIdentifier = matcher({
    type: "Identifier"
});

var isSimpleMemberExpression = matcher({
    type: "MemberExpression",
    computed: false,
    object: (ast) => isIdentifier(ast) || isSimpleMemberExpression(ast),
    property: isIdentifier
});

function isNamedExpression (ast) {
    return isIdentifier(ast) || isSimpleMemberExpression(ast);
}


function allKeypathsInAst(ast) {
    var keypaths = [];
    function f(node, keypath) {
        node.forEach((child, key) => {
            var childKeypath = keypath.concat([key]);
            keypaths.push(childKeypath);
            if (child && child.forEach) {
                f(child, childKeypath);
            }
        });
    }
    f(ast, []);
    return I.fromJS(keypaths);
}



// ==================================
// TRANSLATING
// ==================================

/*
    Return the keypath for each message in the given ast,
    and (important) return them with ancestors coming before descendents
    and earlier messages in the source coming before later messages.
*/
function keypathsForMessageNodesInAst(ast) {
    var keypaths = allKeypathsInAst(ast)
        .filter(keypath => isMarker(ast.getIn(keypath)));

    // Validate arguments of string markers:
    keypaths.forEach(keypath => {
        var messageMarker = ast.getIn(keypath);        
        if (isStringMarker(messageMarker)) {
            if ( messageMarker.get('arguments').size !== 1 ) {
                throw new InputError("Message marker must have exactly one argument: " + generate(messageMarker));
            }
            if ( !isStringLiteral(messageMarker.getIn(['arguments', 0])) ) {
                throw new InputError("Message should be a string literal, but was instead: " + generate(messageMarker));
            }
        }
    });

    return keypaths;
}

function translateMessagesInAst(ast, translations) {
    // Substitute at a single keypath based on translations:
    function substitute(ast, keypath) {
        try {
            var message = ast.getIn(keypath);
            var translation = translations[generateMessage(sanitize(message))];
            if(!translation) { throw new InputError("Translation missing for:\n" + generateMessage(sanitize(message))); }
            translation = prepareTranslationForParsing(translation, message);
            return ast.setIn(keypath,
                reconstitute(
                    validateTranslation(parseFragment(translation), message),
                    message));
        } catch(e) {
            throw e.set ? e.set('messageAst', message).set('translationString', translation) : e;
        }
    }

    // Note that the message is pulled from the partially reduced AST; in this
    // way, already-translated inner messages are used when processing outer
    // messages, so they don't get clobbered.

    // Perform this substitution for all message keypaths, starting
    // at the bottom of the document, and processing inner nested messages
    // before outer messages. This ensures that no operation will invalidate
    // the keypath of another operation, either by changing array indices
    // or relocating an inner message within an outer one:
    var keypaths = keypathsForMessageNodesInAst(ast);
    return keypaths.reduceRight(substitute, ast);
}


// ==================================
// PRINTING AND UNPRINTING
// ==================================

function generateMessage (ast) {
    if (isStringMarker(ast)) {
        return ast.getIn(['arguments', 0, 'value']);
    }
    else if (isElementMarker(ast)) {
        return ast.get('children').map(generateJsxChild).join('');
    }
    else {
        throw new Error("Internal error: message is not string literal or JSX element: " + generate(ast));
    }
}

function generateJsxChild (ast) {
    if (isStringLiteral(ast)) {
        return ast.get('value')
    } else {
        return generate(ast);
    }
}

function prepareTranslationForParsing (translationString, originalAst) {
    if (isStringMarker(originalAst)) {
        return JSON.stringify(translationString);
    }
    else if (isElementMarker(originalAst)) {
        return "<I18N>" + translationString + "</I18N>";
    }
    else {
        throw new Error("Internal error: message is not string literal or JSX element: " + generate(ast));
    }
}


// ==================================
// EXPORTS
// ==================================

module.exports = {
    /*
        Given a source code string, return an array of message strings.
    */
    extractMessages: function extractMessages(src) {
        var ast = parse(src);
        return keypathsForMessageNodesInAst(ast)
            .map(keypath => ast.getIn(keypath))
            .map(message => {
                try {
                    return generateMessage(sanitize(validateMessage(message)))
                } catch (e) {
                    throw e.set ? e.set('messageAst', message) : e;
                }
            })
            .toJS();
    },

    /*
        Given a source code string and a translations dictionary,
        return the source code as a string with the messages translated.
    */
    translateMessages: function translateMessages(src, translations) {
        return generate(translateMessagesInAst(parse(src), translations));
    },

    /*
        If the given error represents an error in the inputted JSX files or
        translations, then return a user-friendly error message without
        a stack trace. If it is any other kind of error, return the basic
        error message and stack trace.
    */
    errorMessageForError: function errorMessageForError(e) {
        if (isInputError(e) && e.get('messageAst') && e.get('translationString')) {
            var ast = e.get('messageAst');
            return (
                "\nOn line " + ast.getIn(['loc', 'start', 'line']) + ", when processing the message... \n\n" +
                generate(ast) + "\n\n" +
                "...and its associated translation... \n\n" +
                e.get('translationString') + "\n\n" +
                "...the following error occured: \n\n" +
                e.get('description') + "\n"
            );
        }
        else if (isInputError(e) && e.get('messageAst')) {
            var ast = e.get('messageAst');
            return (
                "\nOn line " + ast.getIn(['loc', 'start', 'line']) + ", when processing the message... \n\n" +
                generate(ast) + "\n\n" +
                "...the following error occured: \n\n" +
                e.get('description') + "\n"
            );
        }
        else if (isInputError(e)) {
            return e.get('description') + "\n";
        }
        else {
            return e.stack;
        }
    }
}
