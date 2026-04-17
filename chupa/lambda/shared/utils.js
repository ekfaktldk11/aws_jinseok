const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient } = require("@aws-sdk/lib-dynamodb");

const client = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(client);

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

function ok(body) {
  return { statusCode: 200, headers, body: JSON.stringify(body) };
}

function created(body) {
  return { statusCode: 201, headers, body: JSON.stringify(body) };
}

function badRequest(message) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: message }) };
}

function notFound(message = "Not found") {
  return { statusCode: 404, headers, body: JSON.stringify({ error: message }) };
}

function forbidden(message = "Forbidden") {
  return { statusCode: 403, headers, body: JSON.stringify({ error: message }) };
}

function serverError(message = "Internal server error") {
  return { statusCode: 500, headers, body: JSON.stringify({ error: message }) };
}

function getUserIdFromEvent(event) {
  return event.requestContext?.authorizer?.claims?.sub || null;
}

module.exports = { ddb, ok, created, badRequest, notFound, forbidden, serverError, getUserIdFromEvent };
