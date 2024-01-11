'use strict';

/* istanbul ignore file */

const parsePreferHeader = require('parse-prefer-header');
const memoize = require('micro-memoize');
const logger = require('lllog')();
const colors = require('colors');

// Create a function that is memoized using the URL, query, the Prefer header and the body.
const getResponse = (path, url, query, preferHeader, body, headers) => {
	const { example: preferredExampleName, statuscode: preferredStatusCode } = parsePreferHeader(preferHeader) || {};
	const requestExampleName = path.findPreferredExampleByRequest(url, query, body, headers);

	if(preferredStatusCode)
		logger.debug(`Searching requested response with status code ${preferredStatusCode}`);
	else if(preferredExampleName)
		logger.debug(`Searching requested response using example name ${preferredExampleName}`);
	else
		logger.debug('Searching response with request example');
	return path.getResponse(preferredStatusCode, preferredExampleName || requestExampleName);
};

const getResponseMemo = memoize(getResponse, {
	maxSize: 10
});

const checkContentType = req => {
	const contentType = req.header('content-type');
	if(!contentType)
		logger.warn(`${colors.yellow('*')} Missing content-type header`);
};

const handleRequest = (path, responseHandler, securityConfig) => (req, res) => {

	checkContentType(req);

	const {
		query,
		params,
		headers,
		cookies,
		body: requestBody
	} = req;

	const { securitySchemes, globalSecurity } = securityConfig;

	// Handle security
	if(securitySchemes && Object.keys(securitySchemes).length > 0) {
		const pathSecurity = path.security || globalSecurity || [];
		const validSecurities = pathSecurity.filter(value => Object.keys(value).length !== 0).flatMap(x => Object.keys(x));
		if(validSecurities && validSecurities.length > 0) {
			let isValidRequest = true;
			for(const securityKey of validSecurities) {
				const securityScheme = securitySchemes[securityKey];
				if(securityScheme) {
					if(securityScheme.type === 'apiKey') {
						let securityCheck = null;
						switch(securityScheme.in) {
							case 'header':
								securityCheck = headers[securityScheme.name.toLowerCase()];
								break;
							case 'query':
								securityCheck = query[securityScheme.name.toLowerCase()];
								break;
							case 'cookie':
								securityCheck = cookies[securityScheme.name.toLowerCase()];
								break;
							default:
								securityCheck = null;
								break;

						}
						if(!securityCheck || (securityScheme['x-value'] && String(securityCheck) !== String(securityScheme['x-value'])))
							isValidRequest = false;

					} else {
						const { authorization } = headers;
						if(!authorization)
							isValidRequest = false;
						else {
							const [scheme, token] = authorization.split(' ');
							if(scheme.toLowerCase() !== securityScheme.scheme.toLowerCase() || (securityScheme['x-value'] && securityScheme['x-value'] !== token))
								isValidRequest = false;
						}
					}
				}
			}
			if(isValidRequest === false)
				return responseHandler(req, res, { errors: 'Unauthorized' }, 401);
		}
	}

	const failedValidations = path.validateRequestParameters({
		query,
		path: params,
		headers,
		cookies,
		requestBody
	});

	if(failedValidations.length)
		return responseHandler(req, res, { errors: failedValidations }, 400);

	const preferHeader = req.header('prefer') || '';

	const { statusCode, headers: responseHeaders, body, responseMimeType } =
			getResponseMemo(path, req.path, JSON.stringify(req.query), preferHeader, JSON.stringify(requestBody), req.headers);

	return responseHandler(req, res, body, statusCode, responseHeaders, responseMimeType);
};

module.exports = handleRequest;
