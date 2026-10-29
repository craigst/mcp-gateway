/**
 * Public catalog surface: repository, ranking, and the zero-trust catalog service.
 */
export { SqliteCatalogRepository } from './repository.js';
export {
  rankTools,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from './search.js';
export { DefaultCatalogService } from './service.js';
