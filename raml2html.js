import raml2obj from 'raml2obj';
import handlebars from 'handlebars';
import marked from 'marked';
import pjson from './package.json';
import fs from 'fs';
import path from 'path';
import util from 'util';

const AVAILABLE_METHODS = ['get', 'post', 'put', 'delete', 'patch'];

/**
 * Render the source RAML object using the config's processOutput function
 *
 * The config object should contain at least the following property:
 * processRamlObj: function that takes the raw RAML object and returns a promise with the rendered HTML
 *
 * @param {(String|Object)} source - The source RAML file. Can be a filename, url, contents of the RAML file,
 * or an already-parsed RAML object.
 * @param {Object} config
 * @param {Function} config.processRamlObj
 * @returns a promise
 */
function render(source, config) {
    config = config || {};
    config.raml2HtmlVersion = pjson.version;

    return raml2obj.parse(source)
        .then(ramlObj => {
            ramlObj.config = config;

            if (config.processRamlObj) {
                return config.processRamlObj(ramlObj).then(html => {
                    if (config.postProcessHtml) {
                        return config.postProcessHtml(html);
                    }

                    return html;
                });
            }

            return ramlObj;
        });
}

function processObj(obj) {
    //console.dir(obj);
    //console.log(util.inspect(obj, {showHidden: false, depth: null}));

    let processResource = (res, url, securitySchemes, traits) => {
        let ss = JSON.parse(JSON.stringify(securitySchemes)),
            tr = JSON.parse(JSON.stringify(traits));

        let keys = Object.keys(res);
        for (let i = 0; i < keys.length; i++) {
            let key = keys[i];

            if (key.substr(0, 1) != '/') {
                if (key === 'securedBy') {
                    ss = res[key];
                } else if (key === 'is') {
                    tr = res[key];
                }

                continue;
            }

            let subRes = res[key];

            subRes = processResource(subRes, url + key, ss, tr);

            subRes.parentUrl = url;
            subRes.relativeUri = key;
            subRes.methods = {};
            for (let m of AVAILABLE_METHODS) {
                if (subRes.hasOwnProperty(m)) {
                    subRes.methods[m] = subRes[m];
                    delete subRes[m];
                }
            }

            res.resources = res.resources || [];
            res.resources.push(subRes);
            delete res[key];
        }

        return res;
    };

    obj = processResource(obj, '', null, null);

    //console.log('--------------------------------------------------------------');
    //console.log(obj);
    //console.log(util.inspect(obj, {showHidden: false, depth: null}));

    return obj;
}

/**
 * @param {String} [mainTemplate] - The filename of the main template, leave empty to use default templates
 * @param {String} [templatesPath] - Optional, by default it uses the current working directory
 * @returns {{processRamlObj: Function, postProcessHtml: Function}}
 */
function getDefaultConfig(mainTemplate, templatesPath) {
    if (!mainTemplate) {
        mainTemplate = 'main.html';
        templatesPath = path.join(__dirname, './templates/');

        let dir = fs.readdirSync(templatesPath);
        for (let i = 0; i < dir.length; i++) {
            let filename = dir[i],
                ext = path.extname(filename);

            if (ext === '.html') {
                handlebars.registerPartial(path.basename(filename, ext), fs.readFileSync(path.join(templatesPath, filename), {encoding: 'utf8'}));
            }
        }
    }

    // built-in js functions
    handlebars.registerHelper('join', arr => arr.join(','));
    handlebars.registerHelper('dot2underscore', str => str.replace(/\./g, '_'));
    handlebars.registerHelper('isObject', obj => typeof obj === 'object');
    handlebars.registerHelper('returnOr', (one, two) => one || two);
    handlebars.registerHelper('returnAnd', (one, two) => one && two);
    handlebars.registerHelper('firstEl', arr => arr[0]);
    handlebars.registerHelper('firstElNotNull', arr => arr && arr[0] !== 'null');
    handlebars.registerHelper('isEq', (one, two) => one == two);
    handlebars.registerHelper('isNotEq', (one, two) => one != two);
    handlebars.registerHelper('isString', one => typeof one === 'string');

    // libraries
    let renderer = new marked.Renderer();
    // Render Bootstrap style tables
    renderer.table = (thead, tbody) => `<table class="table"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
    handlebars.registerHelper('markdown', md => md ? new handlebars.SafeString(marked(md, {renderer: renderer, pedantic: true, sanitize: true})) : '');

    // view logic
    handlebars.registerHelper('describeResource', function() {
        return this.methods || (this.description && this.parentUrl);
    });
    handlebars.registerHelper('hasRequest', function() {
        return (this.allUriParameters && this.allUriParameters.length) || this.queryParameters || this.headers || this.body;
    });
    handlebars.registerHelper('typeString', function() {
        return this.type == 'string';
    });

    return {
        processRamlObj: ramlObj => {
            ramlObj = processObj(ramlObj);

            let processType = type => {
                //console.log('pr t:', type);

                let isObject = typeof type === 'object',
                    typeName = isObject ? type.type || type.parentType : type,
                    t        = typeName ? typeName.replace(/^([.\w]+)\b(\[\])?$/, '$1') : '',
                    isArray  = typeName && typeName.substr(-2, 2) === '[]',
                    exists   = t && ramlObj.types.hasOwnProperty(t),
                    uses     = false;

                if (t.indexOf('.') >= 0) {
                    uses = t.split('.').shift();
                    t = t.split('.').pop();

                    exists = !!(uses && ramlObj.uses && ramlObj.uses[uses] && ramlObj.uses[uses].types && ramlObj.uses[uses].types[t]);
                }

                let typ;
                if (exists) {
                    if (!uses) {
                        typ = JSON.parse(JSON.stringify(ramlObj.types[t]));
                    } else {
                        typ = JSON.parse(JSON.stringify(ramlObj.uses[uses].types[t]));
                    }
                } else {
                    typ = JSON.parse(JSON.stringify(type));
                }

                if (typeof typ != 'object') {
                    return typ;
                }

                if (exists) {
                    typ.parentType = t;
                    typ.isArray = isArray;

                    // properties of parent type
                    if (typ.type) {
                        //console.log('par:', typ);
                        let extend = processType(typ.type);

                        if (extend.hasOwnProperty('properties')) {
                            let extendKeys = Object.keys(extend.properties);

                            for (let i = 0; i < extendKeys.length; i++) {
                                let extendKey = extendKeys[i];

                                if (!typ.properties[extendKey]) {
                                    typ.properties[extendKey] = extend.properties[extendKey];
                                }
                            }
                        }
                    }

                    // properties of base type
                    if (typ.properties) {
                        let props = Object.keys(typ.properties);
                        for (let i = 0; i < props.length; i++) {
                            let key = props[i],
                                prop = typ.properties[key];

                            //console.log('key:', key);
                            typ.properties[key] = processType(prop);
                        }
                    }
                }

                if (!typ.displayName && !typ.parentType) {
                    typ.displayName = 'Объект';
                }

                // inline properties of object
                if (type.properties) {
                    let props = Object.keys(type.properties);
                    for (let i = 0; i < props.length; i++) {
                        let key = props[i],
                            prop = type.properties[key];

                        //console.log('in key:', key);
                        typ.properties[key] = processType(prop);
                    }
                }

                return typ;
            };
            handlebars.registerHelper('getType', type => processType(type));
            //handlebars.registerHelper('getType', function(type) {
                //console.log('getType:', this, type);
                //return processType(type);
            //});
            let processResourceTypePattern = (rtPart, pattern) => {
                if (typeof rtPart !== 'object') {
                    return rtPart;
                }

                let availablePatternKeys = ['example', 'description'];

                let keys = Object.keys(rtPart);
                for (var i = 0; i < keys.length; i++) {
                    var key = keys[i];

                    if (!rtPart.hasOwnProperty(key)) {
                        continue;
                    }

                    if (availablePatternKeys.indexOf(key) >= 0) {
                        let patternKeys = Object.keys(pattern);
                        for (let j = 0; j < patternKeys.length; j++) {
                            let patternKey = patternKeys[j];

                            rtPart[key] = rtPart[key].replace(new RegExp(`<<${patternKey}>>`, 'g'), pattern[patternKey]);
                        }
                    } else if (typeof rtPart[key] === 'object') {
                        rtPart[key] = processResourceTypePattern(rtPart[key], pattern);
                    }
                }

                return rtPart;
            };
            let deepMerge = (toRaw, fromRaw) => {
                let to = JSON.parse(JSON.stringify(toRaw)),
                    from = JSON.parse(JSON.stringify(fromRaw)),
                    fromKeys = Object.keys(from);

                for (let i = 0; i < fromKeys.length; i++) {
                    let fromKey = fromKeys[i];

                    if (!to[fromKey]) {
                        to[fromKey] = from[fromKey];
                    } else if (typeof to[fromKey] === 'object') {
                        to[fromKey] = deepMerge(to[fromKey], from[fromKey]);
                    }
                }

                return to;
            };
            handlebars.registerHelper('getMethods', resource => {
                let methods = JSON.parse(JSON.stringify(resource.methods));

                // resource types
                if (resource.type) {
                    let resourceTypes = Object.keys(resource.type);
                    for (let i = 0; i < resourceTypes.length; i++) {
                        let resourceTypeKey = resourceTypes[i],
                            resourceType = JSON.parse(JSON.stringify(ramlObj.resourceTypes[resourceTypeKey])),
                            rtMethods = Object.keys(resourceType);

                        for (let j = 0; j < rtMethods.length; j++) {
                            let rtMethodKey = rtMethods[j];

                            if (!methods[rtMethodKey]) {
                                methods[rtMethodKey] = processResourceTypePattern(resourceType[rtMethodKey], resource.type[resourceTypeKey]);
                            }
                        }
                    }
                }

                // security schemes
                if (ramlObj.securedBy) {
                    let keys = Object.keys(methods);

                    for (let i = 0; i < keys.length; i++) {
                        let key = keys[i];

                        if (AVAILABLE_METHODS.indexOf(key) === -1) {
                            continue;
                        }

                        if (!methods[key].securedBy) {
                            methods[key].securedBy = ramlObj.securedBy;

                            for (let j = 0; j < ramlObj.securedBy.length; j++) {
                                let secKey = ramlObj.securedBy[j],
                                    sec = ramlObj.securitySchemes[secKey];

                                if (sec.describedBy) {
                                    if (sec.describedBy.headers) {
                                        methods[key].headers = methods[key].headers || {};
                                        let hKeys = Object.keys(sec.describedBy.headers);

                                        for (let k = 0; k < hKeys.length; k++) {
                                            let hKey = hKeys[k];

                                            methods[key].headers[hKey] = sec.describedBy.headers[hKey];
                                        }
                                    }

                                    if (sec.describedBy.responses) {
                                        methods[key].responses = methods[key].responses || {};
                                        let hKeys = Object.keys(sec.describedBy.responses);

                                        for (let k = 0; k < hKeys.length; k++) {
                                            let hKey = hKeys[k];

                                            methods[key].responses[hKey] = sec.describedBy.responses[hKey];
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // traits
                let methodNames = Object.keys(methods);
                for (let i = 0; i < methodNames.length; i++) {
                    let methodName = methodNames[i],
                        method = methods[methodName];

                    if (method.is) {
                        for (let j = 0; j < method.is.length; j++) {
                            let traitName = method.is[j];

                            if (ramlObj.traits && ramlObj.traits[traitName]) {
                                methods[methodName] = deepMerge(methods[methodName], ramlObj.traits[traitName]);
                            }
                        }
                    }
                }

                return methods;
            });
            handlebars.registerHelper('getSecuritySchema', function(name) {
                return ramlObj.securitySchemes[name];
            });

            let template = handlebars.compile(
                fs.readFileSync(path.join(templatesPath, mainTemplate), {encoding: 'utf8'}),
                {trackIds: true}
            );
            let html = template(ramlObj);

            // Return the promise with the html
            return new Promise(resolve => resolve(html));
        },

        postProcessHtml: html => {
            // Minimize the generated html and return the promise with the result
            let Minimize = require('minimize'),
                minimize = new Minimize({});

            return new Promise((resolve, reject) => {
                minimize.parse(html, (error, result) => {
                    if (error) {
                        reject(new Error(error));
                    } else {
                        resolve(result);
                    }
                });
            });
        }
    };
}

module.exports = {
    getDefaultConfig: getDefaultConfig,
    render:           render
};

if (require.main === module) {
    console.log('This script is meant to be used as a library. You probably want to run bin/raml2html if you\'re looking for a CLI.');
    process.exit(1);
}
