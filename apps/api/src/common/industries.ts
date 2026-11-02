/**
 * Rubros y vocabulario del tenant. La implementación se movió a `@conversia/config`
 * porque el WORKER también la necesita (el título del evento de Google Calendar no
 * puede decir "Paciente" en una barbería). Este archivo queda como re-export para
 * no tocar a sus consumidores de la api.
 */
export {
  BASE_VOCAB,
  INDUSTRIES,
  resolvePersonalization,
  type Industry,
  type ModuleKey,
  type Modules,
  type TermKey,
  type Vocabulary,
} from "@conversia/config";
