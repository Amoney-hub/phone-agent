// OpenAPI 3.1 spec for the /v1 developer API. Built as a plain object so it can
// be served at /v1/openapi.json and rendered into human docs (see the Developer
// tab). Keep this in sync with the routes in src/apiv1.js.

function errorResponse(description) {
  return {
    description,
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };
}

const COMMON_ERRORS = {
  400: errorResponse("Invalid request."),
  401: errorResponse("Missing or invalid API key."),
  404: errorResponse("Resource not found."),
  429: errorResponse("Rate limit exceeded."),
};

export function buildOpenApiSpec({ baseUrl } = {}) {
  const server = baseUrl ? [{ url: `${baseUrl.replace(/\/$/, "")}/v1` }] : [{ url: "/v1" }];
  return {
    openapi: "3.1.0",
    info: {
      title: "Phone Agent API",
      version: "1.0.0",
      description:
        "REST API for placing AI phone calls, sending SMS, and managing contacts. " +
        "Authenticate with `Authorization: Bearer <api_key>`. All responses are JSON. " +
        "Errors use a consistent `{ error: { type, code, message } }` shape.",
    },
    servers: server,
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Calls" },
      { name: "Messages" },
      { name: "Contacts" },
      { name: "Batches" },
      { name: "Usage" },
      { name: "Webhooks" },
    ],
    paths: {
      "/calls": {
        get: {
          tags: ["Calls"], summary: "List calls", operationId: "listCalls",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", default: 50, maximum: 200 } },
            { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
          ],
          responses: { 200: { description: "A page of calls.", content: { "application/json": { schema: { $ref: "#/components/schemas/CallList" } } } }, ...COMMON_ERRORS },
        },
        post: {
          tags: ["Calls"], summary: "Create a call", operationId: "createCall",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateCall" } } } },
          responses: { 201: { description: "The call was placed.", content: { "application/json": { schema: { $ref: "#/components/schemas/Call" } } } }, 422: errorResponse("The objective is missing required information."), ...COMMON_ERRORS },
        },
      },
      "/calls/{id}": {
        get: {
          tags: ["Calls"], summary: "Retrieve a call", operationId: "getCall",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The call.", content: { "application/json": { schema: { $ref: "#/components/schemas/Call" } } } }, ...COMMON_ERRORS },
        },
      },
      "/messages": {
        post: {
          tags: ["Messages"], summary: "Send an SMS", operationId: "sendMessage",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateMessage" } } } },
          responses: { 201: { description: "The message was sent.", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, ...COMMON_ERRORS },
        },
      },
      "/messages/{id}": {
        get: {
          tags: ["Messages"], summary: "Retrieve a message", operationId: "getMessage",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The message.", content: { "application/json": { schema: { $ref: "#/components/schemas/Message" } } } }, ...COMMON_ERRORS },
        },
      },
      "/contacts": {
        get: {
          tags: ["Contacts"], summary: "List contacts", operationId: "listContacts",
          responses: { 200: { description: "All contacts.", content: { "application/json": { schema: { $ref: "#/components/schemas/ContactList" } } } }, ...COMMON_ERRORS },
        },
        post: {
          tags: ["Contacts"], summary: "Create a contact", operationId: "createContact",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateContact" } } } },
          responses: { 201: { description: "The contact.", content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } } }, ...COMMON_ERRORS },
        },
      },
      "/contacts/{id}": {
        get: {
          tags: ["Contacts"], summary: "Retrieve a contact", operationId: "getContact",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "The contact.", content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } } }, ...COMMON_ERRORS },
        },
        put: {
          tags: ["Contacts"], summary: "Update a contact", operationId: "updateContact",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateContact" } } } },
          responses: { 200: { description: "The updated contact.", content: { "application/json": { schema: { $ref: "#/components/schemas/Contact" } } } }, ...COMMON_ERRORS },
        },
        delete: {
          tags: ["Contacts"], summary: "Delete a contact", operationId: "deleteContact",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
          responses: { 200: { description: "Deleted.", content: { "application/json": { schema: { $ref: "#/components/schemas/Deleted" } } } }, ...COMMON_ERRORS },
        },
      },
      "/batches": {
        post: {
          tags: ["Batches"], summary: "Create a batch of calls", operationId: "createBatch",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateBatch" } } } },
          responses: { 201: { description: "The batch.", content: { "application/json": { schema: { $ref: "#/components/schemas/Batch" } } } }, ...COMMON_ERRORS },
        },
      },
      "/batches/{id}": {
        get: {
          tags: ["Batches"], summary: "Retrieve a batch", operationId: "getBatch",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { 200: { description: "The batch and its calls.", content: { "application/json": { schema: { $ref: "#/components/schemas/Batch" } } } }, ...COMMON_ERRORS },
        },
      },
      "/usage": {
        get: {
          tags: ["Usage"], summary: "Get usage", operationId: "getUsage",
          parameters: [{ name: "period", in: "query", schema: { type: "string", enum: ["day", "week", "month", "all"], default: "month" } }],
          responses: { 200: { description: "Usage totals.", content: { "application/json": { schema: { $ref: "#/components/schemas/Usage" } } } }, ...COMMON_ERRORS },
        },
      },
      "/webhooks": {
        get: {
          tags: ["Webhooks"], summary: "Get webhook config", operationId: "getWebhook",
          responses: { 200: { description: "The webhook configuration.", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } }, ...COMMON_ERRORS },
        },
        put: {
          tags: ["Webhooks"], summary: "Set webhook config", operationId: "setWebhook",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/SetWebhook" } } } },
          responses: { 200: { description: "The updated configuration.", content: { "application/json": { schema: { $ref: "#/components/schemas/Webhook" } } } }, ...COMMON_ERRORS },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Your API key from the Developer console." },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                type: { type: "string", example: "invalid_request_error" },
                code: { type: "string", example: "missing_field" },
                message: { type: "string", example: "name is required." },
                param: { type: "string", nullable: true },
              },
              required: ["type", "code", "message"],
            },
          },
        },
        Call: {
          type: "object",
          properties: {
            id: { type: "string", example: "call_abc123" },
            object: { type: "string", example: "call" },
            status: { type: "string" },
            outcome: { type: "string", nullable: true },
            ended_reason: { type: "string", nullable: true },
            callback_time: { type: "string", nullable: true },
            duration_seconds: { type: "integer", nullable: true },
            phone: { type: "string", nullable: true },
            contact_name: { type: "string", nullable: true },
            summary: { type: "string", nullable: true },
            transcript: { type: "string", nullable: true },
            recording_url: { type: "string", nullable: true },
            batch_id: { type: "string", nullable: true },
            created_at: { type: "string", nullable: true },
          },
        },
        CreateCall: {
          type: "object",
          properties: {
            contact: { type: "string", description: "Name of a saved contact." },
            phone: { type: "string", description: "E.164 number (used when no contact name is given)." },
            name: { type: "string", description: "Contact name to create/use when calling by phone." },
            objective: { type: "string", description: "Plain-language goal of the call." },
            voicemail_message: { type: "string", nullable: true },
          },
          required: ["objective"],
        },
        CallList: {
          type: "object",
          properties: {
            object: { type: "string", example: "list" },
            data: { type: "array", items: { $ref: "#/components/schemas/Call" } },
            has_more: { type: "boolean" },
          },
        },
        Message: {
          type: "object",
          properties: {
            id: { type: "string", example: "msg_abc123" },
            object: { type: "string", example: "message" },
            to: { type: "string" },
            body: { type: "string" },
            status: { type: "string" },
            created_at: { type: "string" },
          },
        },
        CreateMessage: {
          type: "object",
          properties: { to: { type: "string" }, body: { type: "string" } },
          required: ["to", "body"],
        },
        Contact: {
          type: "object",
          properties: {
            id: { type: "integer" },
            object: { type: "string", example: "contact" },
            name: { type: "string" },
            phone: { type: "string" },
            created_at: { type: "string" },
          },
        },
        CreateContact: {
          type: "object",
          properties: { name: { type: "string" }, phone: { type: "string" } },
          required: ["name", "phone"],
        },
        ContactList: {
          type: "object",
          properties: {
            object: { type: "string", example: "list" },
            data: { type: "array", items: { $ref: "#/components/schemas/Contact" } },
          },
        },
        Deleted: {
          type: "object",
          properties: { id: {}, object: { type: "string" }, deleted: { type: "boolean" } },
        },
        CreateBatch: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string" }, description: "Saved contact names to call." },
            objective: { type: "string" },
            voicemail_message: { type: "string", nullable: true },
          },
          required: ["names", "objective"],
        },
        Batch: {
          type: "object",
          properties: {
            id: { type: "string", example: "batch_abc123" },
            object: { type: "string", example: "batch" },
            objective: { type: "string", nullable: true },
            calls: { type: "array", items: { $ref: "#/components/schemas/Call" } },
          },
        },
        Usage: {
          type: "object",
          properties: {
            object: { type: "string", example: "usage" },
            period: { type: "string" },
            calls: { type: "integer" },
            minutes: { type: "number" },
            messages: { type: "integer" },
          },
        },
        Webhook: {
          type: "object",
          properties: {
            object: { type: "string", example: "webhook" },
            url: { type: "string", nullable: true },
            enabled: { type: "boolean" },
            secret: { type: "string", nullable: true, description: "Signing secret (shown to owner)." },
          },
        },
        SetWebhook: {
          type: "object",
          properties: {
            url: { type: "string", nullable: true },
            enabled: { type: "boolean" },
            rotate_secret: { type: "boolean" },
          },
        },
      },
    },
  };
}
