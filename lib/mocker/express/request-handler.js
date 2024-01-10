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

const handleRequest = (path, responseHandler) => (req, res) => {

	checkContentType(req);

	const {
		query,
		params,
		headers,
		cookies,
		body: requestBody
	} = req;

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
