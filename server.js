const path = require("path");

const express = require("express");
const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const app = express();

const PORT = process.env.PORT || 3000;

// books.db lives in the same folder as this file and is rebuilt from seed.sql.
const DB_PATH = path.join(__dirname, "books.db");

// express.json() reads the JSON request body and makes it available as req.body.
app.use(express.json());

// The single database connection. It is opened once in initializeDBAndServer().
let db;

// order_by and order cannot use ? placeholders, so they are checked against
// these fixed lists before they are written into the SQL text.
const SORTABLE_COLUMNS = ["id", "title", "author", "price", "pages"];
const SORT_DIRECTIONS = ["ASC", "DESC"];

// Defaults and limits for the GET /books/ query parameters.
const DEFAULT_LIMIT = 10;
const MAXIMUM_LIMIT = 100;
const DEFAULT_MAX_PRICE = 2147483647;
const MAXIMUM_QUERY_NUMBER = 2147483647;

/**
 * Converts the :bookId route parameter to a positive integer.
 * Returns null when the value is not a valid book ID.
 */
function parseBookId(rawBookId) {
  if (!/^\d+$/.test(rawBookId)) {
    return null;
  }

  const bookId = Number(rawBookId);

  if (!Number.isSafeInteger(bookId) || bookId <= 0) {
    return null;
  }

  return bookId;
}

/**
 * Reads one query parameter and converts it to a whole number.
 * Returns { ok: true, value } when the value is usable, and
 * { ok: false, message } when it is missing from the allowed range.
 */
function readWholeNumber(rawValue, parameterName, defaultValue, minimum, maximum) {
  if (rawValue === undefined) {
    return { ok: true, value: defaultValue };
  }

  // Only digits are accepted, so "abc", "1.5", "-1" and "0x10" are all rejected.
  if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) {
    return {
      ok: false,
      message: `${parameterName} must be a whole number from ${minimum} to ${maximum}.`,
    };
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return {
      ok: false,
      message: `${parameterName} must be a whole number from ${minimum} to ${maximum}.`,
    };
  }

  return { ok: true, value };
}

/**
 * Validates the JSON body used by POST and PUT.
 * Returns an array of readable error messages.
 */
function validateBookBody(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return ["Request body must be a JSON object with title, author, price and pages."];
  }

  const errors = [];
  const { title, author, price, pages } = body;

  if (typeof title !== "string" || title.trim() === "") {
    errors.push("title is required and must be non-empty text.");
  }

  if (typeof author !== "string" || author.trim() === "") {
    errors.push("author is required and must be non-empty text.");
  }

  if (!Number.isInteger(price) || price < 0) {
    errors.push("price is required and must be a whole number, 0 or more.");
  }

  if (!Number.isInteger(pages) || pages < 0) {
    errors.push("pages is required and must be a whole number, 0 or more.");
  }

  return errors;
}

// ---------------------------------------------------------------------------
// REST routes
// ---------------------------------------------------------------------------

// GET /books/ - list books with search, sorting, pagination and a price filter.
app.get("/books/", async (request, response, next) => {
  try {
    // 1. search_q - any text, empty by default.
    const rawSearch = request.query.search_q;

    if (rawSearch !== undefined && typeof rawSearch !== "string") {
      return response.status(400).json({
        message: "search_q must be text.",
      });
    }

    const searchText = rawSearch === undefined ? "" : rawSearch;

    // 2. order_by - must be one of the columns in SORTABLE_COLUMNS.
    const orderByColumn =
      request.query.order_by === undefined ? "id" : request.query.order_by;

    if (!SORTABLE_COLUMNS.includes(orderByColumn)) {
      return response.status(400).json({
        message: `order_by must be one of: ${SORTABLE_COLUMNS.join(", ")}.`,
      });
    }

    // 3. order - ASC or DESC, in either case.
    const rawOrder = request.query.order === undefined ? "ASC" : request.query.order;

    if (typeof rawOrder !== "string") {
      return response.status(400).json({
        message: "order must be ASC or DESC.",
      });
    }

    const orderDirection = rawOrder.toUpperCase();

    if (!SORT_DIRECTIONS.includes(orderDirection)) {
      return response.status(400).json({
        message: "order must be ASC or DESC.",
      });
    }

    // 4. limit, 5. offset, 6. min_price, 7. max_price.
    const limitResult = readWholeNumber(
      request.query.limit,
      "limit",
      DEFAULT_LIMIT,
      1,
      MAXIMUM_LIMIT
    );

    if (!limitResult.ok) {
      return response.status(400).json({ message: limitResult.message });
    }

    const offsetResult = readWholeNumber(
      request.query.offset,
      "offset",
     0,
      0,
      MAXIMUM_QUERY_NUMBER
    );

    if (!offsetResult.ok) {
      return response.status(400).json({ message: offsetResult.message });
    }

    const minPriceResult = readWholeNumber(
      request.query.min_price,
      "min_price",
      0,
      0,
      MAXIMUM_QUERY_NUMBER
    );

    if (!minPriceResult.ok) {
      return response.status(400).json({ message: minPriceResult.message });
    }

    const maxPriceResult = readWholeNumber(
      request.query.max_price,
      "max_price",
      DEFAULT_MAX_PRICE,
      0,
      MAXIMUM_QUERY_NUMBER
    );

    if (!maxPriceResult.ok) {
      return response.status(400).json({ message: maxPriceResult.message });
    }

    if (minPriceResult.value > maxPriceResult.value) {
      return response.status(400).json({
        message: "min_price must be less than or equal to max_price.",
      });
    }

    // The query is built step by step from the validated parts.
    const conditions = [];
    const values = [];

    if (searchText !== "") {
      // LIKE with % on both sides matches the text anywhere inside the title.
      conditions.push("title LIKE ?");
      values.push(`%${searchText}%`);
    }

    conditions.push("price >= ?");
    values.push(minPriceResult.value);

    conditions.push("price <= ?");
    values.push(maxPriceResult.value);

    let sql = "SELECT id, title, author, price, pages FROM book";
    sql += ` WHERE ${conditions.join(" AND ")}`;

    // orderByColumn and orderDirection are safe here because both were checked
    // against the fixed lists above. A column name cannot be a ? placeholder.
    sql += ` ORDER BY ${orderByColumn} ${orderDirection}`;
    sql += " LIMIT ? OFFSET ?";

    values.push(limitResult.value, offsetResult.value);

    const books = await db.all(sql, values);

    response.status(200).json(books);
  } catch (error) {
    next(error);
  }
});

// GET /books/:bookId/ - retrieve one book by ID.
app.get("/books/:bookId/", async (request, response, next) => {
  try {
    const bookId = parseBookId(request.params.bookId);

    if (bookId === null) {
      return response.status(400).json({
        message: "Invalid book ID. It must be a positive whole number.",
      });
    }

    const book = await db.get(
      "SELECT id, title, author, price, pages FROM book WHERE id = ?",
      [bookId]
    );

    if (!book) {
      return response.status(404).json({
        message: `Book with ID ${bookId} was not found.`,
      });
    }

    response.status(200).json(book);
  } catch (error) {
    next(error);
  }
});

// POST /books/ - add a new book.
app.post("/books/", async (request, response, next) => {
  try {
    const validationErrors = validateBookBody(request.body);

    if (validationErrors.length > 0) {
      return response.status(400).json({
        message: validationErrors.join(" "),
      });
    }

    const { title, author, price, pages } = request.body;

    // The ? placeholders keep user input separate from the SQL statement.
    const result = await db.run(
      "INSERT INTO book (title, author, price, pages) VALUES (?, ?, ?, ?)",
      [title.trim(), author.trim(), price, pages]
    );

    response.status(201).json({ id: result.lastID });
  } catch (error) {
    next(error);
  }
});

// PUT /books/:bookId/ - replace all fields of an existing book.
app.put("/books/:bookId/", async (request, response, next) => {
  try {
    const bookId = parseBookId(request.params.bookId);

    if (bookId === null) {
      return response.status(400).json({
        message: "Invalid book ID. It must be a positive whole number.",
      });
    }

    const validationErrors = validateBookBody(request.body);

    if (validationErrors.length > 0) {
      return response.status(400).json({
        message: validationErrors.join(" "),
      });
    }

    const existingBook = await db.get("SELECT id FROM book WHERE id = ?", [bookId]);

    if (!existingBook) {
      return response.status(404).json({
        message: `Book with ID ${bookId} was not found.`,
      });
    }

    const { title, author, price, pages } = request.body;

    await db.run(
      "UPDATE book SET title = ?, author = ?, price = ?, pages = ? WHERE id = ?",
      [title.trim(), author.trim(), price, pages, bookId]
    );

    response.status(200).json({
      message: `Book with ID ${bookId} was updated successfully.`,
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /books/:bookId/ - remove a book.
app.delete("/books/:bookId/", async (request, response, next) => {
  try {
    const bookId = parseBookId(request.params.bookId);

    if (bookId === null) {
      return response.status(400).json({
        message: "Invalid book ID. It must be a positive whole number.",
      });
    }

    const book = await db.get("SELECT id FROM book WHERE id = ?", [bookId]);

    if (!book) {
      return response.status(404).json({
        message: `Book with ID ${bookId} was not found.`,
      });
    }

    await db.run("DELETE FROM book WHERE id = ?", [bookId]);

    response.status(200).json({
      message: `Book with ID ${bookId} was deleted successfully.`,
    });
  } catch (error) {
    next(error);
  }
});

// Unknown routes return the same { message } shape as every other error.
app.use((request, response) => {
  response.status(404).json({
    message: `Route ${request.method} ${request.originalUrl} was not found.`,
  });
});

// Express recognises this as an error handler because it has four parameters.
app.use((error, request, response, next) => {
  // express.json() throws this error when the request body is not valid JSON.
  if (error.type === "entity.parse.failed" || error.status === 400) {
    return response.status(400).json({
      message: "Invalid JSON in the request body.",
    });
  }

  console.error("Unexpected server error:", error);

  response.status(500).json({
    message: "Something went wrong on the server. Please try again.",
  });
});

/**
 * Opens the database once, checks that the book table is readable, and only
 * then starts the Express server. Any failure prints the real error and exits.
 */
async function initializeDBAndServer() {
  try {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });

    const { count } = await db.get("SELECT COUNT(*) AS count FROM book");

    console.log(`Database ready: ${DB_PATH} (${count} books)`);

    const server = app.listen(PORT, () => {
      console.log(`Server running at http://localhost:${PORT}`);
    });

    // A port conflict is not a database error, but it should still be reported
    // clearly instead of showing a long Node.js stack trace.
    server.on("error", (error) => {
      if (error.code === "EADDRINUSE") {
        console.error(
          `Port ${PORT} is already in use. Stop the other server or set a different PORT.`
        );
      } else {
        console.error("Failed to start the server:", error);
      }

      process.exit(1);
    });
  } catch (error) {
    console.error("Failed to initialize the database or server:");
    console.error(error);
    process.exit(1);
  }
}

// Start the server when this file is run directly (node server.js / nodemon).
if (require.main === module) {
  initializeDBAndServer();
}

module.exports = {
  app,
  initializeDBAndServer,
  DB_PATH,
};
