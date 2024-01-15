'use strict';

const logger = require('lllog')();
const util = require('util');
const hash = require('object-hash');
const { Path: PathParser } = require('path-parser');
const CONSTANTS = require('../utils/constants');

const ResponseGenerator = require('../response-generator');
const SchemaValidator = require('../schema-validator');

class Path {

	constructor({
		uri,
		httpMethod,
		parameters,
		requestBody,
		responses,
		security
	}) {

		this.uri = uri;
		this.httpMethod = httpMethod;
		this.parameters = parameters || [];
		this.requestBody = requestBody;
		this.responses = responses;
		this.security = security;
	}

	validateRequestParameters({
		headers,
		query,
		path,
		cookies,
		requestBody
	}) {

		const request = { headers, query, path, cookies };

		return [
			...this.validateRequestBody(requestBody),
			...this.parameters
				.map(parameter => this.validateParameter(parameter, request))
				.filter(validation => !!validation)
		];
	}

	validateRequestBody(requestBody) {

		if(!this.requestBody)
			return [];

		if(!requestBody) {
			if(this.requestBody.required)
				return ['Missing required request body'];

			// If body wasn't required, then there's no problem
			return [];
		}

		const { content } = this.requestBody;

		if(!content || !content['application/json'] || !content['application/json'].schema) {
			// Cannot validate the body if it's application/json content is not defined
			logger.warn('Missing application/json content for request body');
			return [];
		}

		// Validate the body
		const { schema } = content['application/json'];
		try {
			const requestBodyClone = JSON.parse(JSON.stringify(requestBody)); // Deep clone
			const validationErrors = SchemaValidator.validate(requestBodyClone, schema);

			return validationErrors.map(error => {

				const cleanDataPath = error.dataPath.replace(/^\./, '');
				return `Invalid request body:${cleanDataPath && ` '${cleanDataPath}'`} ${error.message}`;
			});
		} catch(e) {
			logger.debug(e.stack);
			return [e.message];
		}
	}

	validateParameter(parameter, { headers, query, path, cookies }) {
		switch(parameter.in) {

			case 'header':
				return this._validateParameter({
					...parameter,
					name: parameter.name.toLowerCase()
				}, headers);

			case 'query':
				return this._validateParameter(parameter, query);

			case 'path':
				return this._validateParameter(parameter, path);

			case 'cookie':
				return this._validateParameter(parameter, cookies);

			default:
				return `Invalid declaration for ${parameter.in} param ${parameter.name}`;
		}
	}

	_validateParameter(parameter, requestParameters) {

		const {
			in: paramIn,
			name,
			required,
			deprecated
		} = parameter;

		if(required && typeof requestParameters[name] === 'undefined')
			return `Missing required ${paramIn} param ${name}`;

		// Optional parameters not sent are always valid
		if(typeof requestParameters[name] === 'undefined')
			return;

		// If a deprecated parameter is received, leave a warning
		if(deprecated)
			logger.warn(`Using deprecated ${paramIn} param ${name}`);

		return this.validateParameterSchema(parameter, requestParameters[name]);
	}

	validateParameterSchema(parameter, value) {

		const { in: paramIn, name, schema } = parameter;

		if(!schema) {
			// Cannot validate a parameter if it's schema is not defined
			logger.warn(`Missing schema for ${paramIn} param ${name}`);
			return;
		}

		if(!schema.type) {
			logger.warn(`Missing schema type for ${paramIn} param ${name}`);
			return;
		}

		return this.validateParameterType(parameter, value)
			|| this.validateParameterEnum(parameter, value);
	}

	validateParameterType({ in: paramIn, name, schema }, value) {

		try {
			const error = this.isValidType(schema.type, value);

			if(error)
				return `Invalid ${paramIn} param ${name}. Expected value of type ${schema.type} but received ${util.inspect(value)}`;

		} catch(e) {
			return `${e.message} for ${paramIn} param ${name}`;
		}
	}

	isValidType(type, value) {
		switch(type) {
			case 'array':
				return !Array.isArray(value);

			case 'object':
				return typeof value !== 'object' || Array.isArray(value);

			case 'string':
				return typeof value !== 'string';

			case 'number':
				return Number.isNaN(Number(value));

			case 'integer':
				return Number.isNaN(Number(value)) || (parseInt(Number(value), 10)) !== Number(value);

			case 'boolean':
				return value !== (!!value) && value !== 'true' && value !== 'false';

			default:
				throw new Error(`Invalid type declaration ${type}`);
		}
	}

	validateParameterEnum({ in: paramIn, name, schema }, value) {

		if(!this.isValidEnumValue(schema.enum, value)) {

			const enumAsString = schema.enum
				.map(util.inspect)
				.join(', ');

			return `Invalid ${paramIn} param ${name}. Expected enum of [${enumAsString}] but received ${util.inspect(value)}`;
		}
	}

	isValidEnumValue(possibleValues, value) {
		return !possibleValues || !possibleValues.length || possibleValues.includes(value);
	}

	getResponse(preferredStatusCode, preferredExampleName) {
		if(preferredStatusCode || preferredExampleName === CONSTANTS.FIRST_RESPONSE) {
			const {
				statusCode,
				headers,
				schema,
				responseMimeType
			} = preferredStatusCode ? this.getResponseByStatusCode(preferredStatusCode) : this.getFirstResponse();

			return {
				statusCode: Number(statusCode),
				headers: headers && this.generateResponseHeaders(headers),
				body: schema ? ResponseGenerator.generate(schema, preferredExampleName) : null,
				responseMimeType
			};
		}

		const {
			statusCode,
			headers,
			body,
			responseMimeType
		} = this.getFirstResponseByExampleName(preferredExampleName);

		return {
			statusCode,
			headers: headers && this.generateResponseHeaders(headers),
			body,
			responseMimeType
		};
	}

	getResponseByStatusCode(statusCode) {

		if(!this.responses[statusCode]) {
			logger.warn(`Could not find a response for status code ${statusCode}. Responding with first response`);
			return this.getFirstResponse();
		}

		const preferredResponse = this.responses[statusCode];

		const [[responseMimeType, responseContent] = []] = Object.entries(preferredResponse.content || {});

		return { statusCode, schema: responseContent, responseMimeType, headers: preferredResponse.headers };
	}

	getFirstResponseByExampleName(preferredExampleName) {
		let defaultResponse = {
			statusCode: 400,
			body: preferredExampleName ? {
				message: `SYSTEM: Could not find a response for example name '${preferredExampleName}'`
			} : null,
			responseMimeType: 'application/json',
			headers: preferredExampleName ? {
				RTag: {
					examples: {
						ex_01: {
							value: preferredExampleName
						}
					}
				}
			} : null
		};
		if(!preferredExampleName)
			return defaultResponse;

		const responseEx = Object.entries(this.responses).find(reponseItem => {
			const [statusCode, preferredResponse] = reponseItem;
			const [[responseMimeType, responseContent] = []] = Object.entries(preferredResponse.content || {});
			if(responseContent && responseContent.examples && Object.values(responseContent.examples).length > 0) {
				// Find example with name
				if(responseContent.examples[preferredExampleName] && responseContent.examples[preferredExampleName].value) {
					const bestExample = responseContent.examples[preferredExampleName].value;
					if(bestExample !== undefined) {
						const headers = preferredResponse.headers || {};
						if(preferredExampleName) {
							headers.RTag = {
								examples: {
									ex_01: {
										value: preferredExampleName
									}
								}
							};
						}
						defaultResponse = {
							statusCode,
							body: bestExample,
							responseMimeType,
							headers
						};
						return true;
					}
				}
			}
			return false;
		});

		if(!responseEx)
			logger.warn(`Could not find a response for example name ${preferredExampleName}. Responding with first response`);
		return defaultResponse;
	}

	getFirstResponse() {

		const [[statusCode, firstResponse]] = Object.entries(this.responses);
		const [[responseMimeType, firstResponseContent] = []] = Object.entries(firstResponse.content || {});

		return { statusCode, schema: firstResponseContent, responseMimeType, headers: firstResponse.headers };
	}

	generateResponseHeaders(headersSchema) {

		const responseHeaders = {};

		for(const [headerName, headerData] of Object.entries(headersSchema))
			responseHeaders[headerName] = ResponseGenerator.generate(headerData);

		return responseHeaders;
	}

	findPreferredExampleByRequest(url, rawQuery, httpRequestBody, requestHeaders) {
		const totalExamples = {};
		const matchExamples = {};

		if(this.parameters) {
			for(const param of this.parameters) {
				if(param.examples) {
					Object.keys(param.examples).forEach(exName => {
						if(!totalExamples[exName])
							totalExamples[exName] = 0;
						totalExamples[exName]++;
					});
				}
			}
		}

		if(this.requestBody && this.requestBody.content) {
			Object.entries(this.requestBody.content).forEach(contentEntries => {
				const requestContentTypeData = contentEntries[1]; // Get value only

				if(requestContentTypeData.examples) {
					Object.keys(requestContentTypeData.examples).forEach(exName => {
						if(!totalExamples[exName])
							totalExamples[exName] = 0;
						totalExamples[exName]++;
					});
				}
			});
		}

		// Return fisrt response if not define any example
		if(Object.keys(totalExamples) === 0)
			return CONSTANTS.FIRST_RESPONSE;

		if(this.uri.includes('{') && this.parameters) {
			const path = new PathParser(this.uri.replace(/{/g, ':').replace(/}/g, ''));
			// Matching
			const pathVariable = path.test(url);

			Object.entries(pathVariable).forEach(queryEntries => {
				const [pathKey, pathValue] = queryEntries;
				const pathDefine = this.parameters.find(x => x.in === 'path' && x.name === pathKey);
				if(pathDefine && pathDefine.examples) {
					Object.entries(pathDefine.examples).forEach(exampleEntries => {
						const [exampleName, exampleData] = exampleEntries;
						if(Object.entries(exampleData.value).toString() === Object.entries(pathValue).toString()) {
							if(!matchExamples[exampleName])
								matchExamples[exampleName] = 0;
							matchExamples[exampleName]++;
						}
					});
				}
			});
		}

		if(rawQuery && this.parameters) {
			const queries = JSON.parse(rawQuery);
			Object.entries(queries).forEach(queryEntries => {
				const [queryKey, queryValue] = queryEntries;
				const queryDefine = this.parameters.find(x => x.in === 'query' && x.name === queryKey);
				if(queryDefine && queryDefine.examples) {
					Object.entries(queryDefine.examples).forEach(exampleEntries => {
						const [exampleName, exampleData] = exampleEntries;
						if(Object.entries(exampleData.value).toString() === Object.entries(queryValue).toString()) {
							if(!matchExamples[exampleName])
								matchExamples[exampleName] = 0;
							matchExamples[exampleName]++;
						}
					});
				}
			});
		}

		if(requestHeaders && this.parameters) {
			Object.entries(requestHeaders).forEach(headerEntries => {
				const [headerKey, headerValue] = headerEntries;
				const headerDefine = this.parameters.find(x => x.in === 'header' && x.name.toLowerCase() === headerKey.toLowerCase());
				if(headerDefine && headerDefine.examples) {
					Object.entries(headerDefine.examples).forEach(exampleEntries => {
						const [exampleName, exampleData] = exampleEntries;
						if(Object.entries(exampleData.value).toString() === Object.entries(headerValue).toString()) {
							if(!matchExamples[exampleName])
								matchExamples[exampleName] = 0;
							matchExamples[exampleName]++;
						}
					});
				}
			});
		}

		if(httpRequestBody && this.requestBody && this.requestBody.content) {
			const bodyObject = typeof httpRequestBody === 'string' ? JSON.parse(httpRequestBody) : httpRequestBody;
			Object.entries(this.requestBody.content).forEach(contentEntries => {
				const requestContentTypeData = contentEntries[1]; // Get value only

				Object.entries(requestContentTypeData.examples).forEach(exampleEntries => {
					const [exampleName, exampleData] = exampleEntries;
					// Compare with hash to ignore case object key not same order.
					if(hash(exampleData.value) === hash(bodyObject)) {
						if(!matchExamples[exampleName])
							matchExamples[exampleName] = 0;
						matchExamples[exampleName]++;
					}
				});
			});
		}

		let responseName;
		Object.entries(matchExamples).forEach(matchItem => {
			const [matchName, matchValue] = matchItem;
			if(matchValue > 0 && matchValue === totalExamples[matchName]) {
				// If not have any match. Assign value.
				// If have any match. Check condition number.
				if(!responseName || matchValue > totalExamples[responseName])
					responseName = matchName;
			}

		});

		return responseName;
	}

}

module.exports = Path;
