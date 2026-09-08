# Project Notes

## 1. The problem

The original business workflow relied on repeated Excel entry for customer orders,
customer-specific prices, monthly reconciliation and continuous-form printing.
This made historical prices easy to overwrite and made repeated data entry
error-prone.

## 2. The solution

This project turns that workflow into a local-first web application. It supports:

- customer and product management;
- customer-specific pricing;
- order entry and payment tracking;
- historical orders and monthly settlement;
- offline mobile requests;
- fixed-format printing;
- Excel import and export.

## 3. Important design decisions

### Integer money

Prices and totals are stored as integer cents rather than floating-point numbers.
For example, 4.25 yuan is stored as 425 cents. This prevents small rounding
errors from accumulating in order totals.

### Precise quantities

Quantities are stored as integer thousandths of a unit. A quantity such as
1.25 jin is represented as 1250 thousandths. The amount calculation multiplies
quantity thousandths by price cents and divides by 1000, rounding to the nearest
cent.

### Historical snapshots

An order stores the product name, customer, price and calculated amount at the
time of ordering. If a product price changes later, old orders remain
financially consistent.

### Idempotent offline synchronisation

Offline requests carry a client request ID. If a mobile device retries the same
request, the server can recognise the duplicate instead of creating a second
order.

### Printing as a domain requirement

The printer uses a fixed continuous-form layout. The application therefore uses
millimetre-based coordinates rather than treating printing as a normal
responsive web page.

## 4. What I contributed

I gathered the workflow requirements, identified the business rules, reviewed the
data model and validation behaviour, checked the system with synthetic demo
data, and iterated on the implementation with tests and documentation.

Codex was used to generate and refactor parts of the implementation. I treated
the generated code as a draft: I reviewed the behaviour, checked calculations
against concrete examples, and documented the design decisions in this
repository.

## 5. Current limitations and next improvements

This is a local-first portfolio prototype rather than a hosted multi-user
service. Possible future improvements include authentication, role-based
permissions, stronger conflict resolution and a hosted deployment.

## 6. What I learned

The project helped me connect a real operational problem with software concepts:
data modelling, validation, fixed-point arithmetic, persistence, idempotency and
testing. It also showed me that software design starts with understanding the
workflow and making its rules explicit.
