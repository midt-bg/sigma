// The institution canonicalization lives in @sigma/shared so the pipeline and the web app fold the
// spellings of one body the SAME way: the filter on /conflicts and a person's timeline group by the key
// this produces, and a second, poorer implementation there split one body into several rows.
export {
  canonicalInstitution,
  declarationInstitution,
  identityInstitution,
  institutionMatchKey,
} from '../../packages/shared/src/institution.ts';
