import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({});
export const ddb = DynamoDBDocumentClient.from(client);

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export function ok(body) {
  return { statusCode: 200, headers, body: JSON.stringify(body) };
}

export function created(body) {
  return { statusCode: 201, headers, body: JSON.stringify(body) };
}

export function badRequest(message) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: message }) };
}

export function notFound(message = "Not found") {
  return { statusCode: 404, headers, body: JSON.stringify({ error: message }) };
}

export function forbidden(message = "Forbidden") {
  return { statusCode: 403, headers, body: JSON.stringify({ error: message }) };
}

export function serverError(message = "Internal server error") {
  return { statusCode: 500, headers, body: JSON.stringify({ error: message }) };
}

export function getUserIdFromEvent(event) {
  return event.requestContext?.authorizer?.claims?.sub || null;
}
