-- A date of birth is not a unique identifier (unlike EGN/LNCH). Preserve each source role,
-- but do not keep the old global-person join for that identifier.
UPDATE registry_roles SET subject_id='local:'||eik||':birthdate:'||lower(subject_id)||':'||subject_name
WHERE subject_kind='person' AND subject_id IN (SELECT indent FROM registry_persons WHERE upper(indent_type)='BIRTHDATE');
UPDATE registry_identity_observations SET subject_kind='other',registry_indent=NULL
WHERE upper(indent_type)='BIRTHDATE';
DELETE FROM person_registry_links WHERE registry_indent IN (SELECT indent FROM registry_persons WHERE upper(indent_type)='BIRTHDATE');
