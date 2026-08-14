// Downloadable reports.
//
//   dataset.ts     the shape a builder produces and both renderers consume
//   range.ts       the from/to window, its labels and its filename fragment
//   csv.ts         RFC 4180 serialization, Excel-safe (BOM, CRLF, no formulas)
//   pdf-report.ts  a generic paginated table renderer built on pdfkit
//   builders.ts    applications / job matches / invoices / analytics datasets
//   response.ts    format validation and the download response
//
// Import from here for the common case; import a module directly when you want
// only its pure half and none of its Prisma loaders.

export * from './dataset';
export * from './range';
export * from './csv';
export * from './pdf-report';
export * from './builders';
export * from './response';
