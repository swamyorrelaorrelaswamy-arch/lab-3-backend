-- seed.sql
-- Rebuilds the book table with the same 9 starting rows as Lab 2.
-- Usage from inside the lab-03 folder: sqlite3 books.db ".read seed.sql"

DROP TABLE IF EXISTS book;

CREATE TABLE book (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT NOT NULL,
    price INTEGER NOT NULL,
    pages INTEGER NOT NULL
);

INSERT INTO book (title, author, price, pages) VALUES
    ('Clean Code', 'Robert C. Martin', 450, 464),
    ('The Pragmatic Programmer', 'Andrew Hunt and David Thomas', 550, 352),
    ('Eloquent JavaScript', 'Marijn Haverbeke', 400, 472),
    ('You Don''t Know JS Yet', 'Kyle Simpson', 300, 146),
    ('Node.js Design Patterns', 'Mario Casciaro', 650, 660),
    ('JavaScript: The Good Parts', 'Douglas Crockford', 350, 176),
    ('Head First JavaScript Programming', 'Eric Freeman and Elisabeth Robson', 500, 704),
    ('The Rust Programming Language', 'Steve Klabnik and Carol Nichols', 600, 560),
    ('Designing Data-Intensive Applications', 'Martin Kleppmann', 750, 616);
