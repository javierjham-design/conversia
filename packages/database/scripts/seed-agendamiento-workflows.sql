-- 3 workflows de agendamiento (recordatorio + recaptura no-show + recaptura
-- tratamiento) para la org piloto (Digital Dent). Idempotente.
-- Ejecuta contra PROD:  psql "$DATABASE_PUBLIC_URL" -f seed-agendamiento-workflows.sql
--
-- Prerrequisitos (§6 del spec): WABA activa + settings.messaging.defaultReminderChannelId
-- + 3 plantillas WhatsApp APPROVED sincronizadas (recordatorio_cita, recaptura_noshow,
-- recaptura_tratamiento). Cada workflow se resuelve su plantilla por NOMBRE; si falta,
-- se AVISA y ese workflow se omite (re-ejecuta el seed cuando la plantilla exista).
--
-- Los send_template usan config.templateId (id real resuelto aquí). Los switch_agent
-- usan agentSlug="agendamiento" (sembrar antes seed-agendamiento-agent.sql).

-- Upsert idempotente de un workflow publicado+activo por (org, name).
CREATE OR REPLACE FUNCTION pg_temp.seed_wf(p_org text, p_name text, p_desc text, p_def jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  v_wf text;
  v_cur text;
  v_ver int;
  v_ver_id text;
BEGIN
  SELECT id, current_version_id INTO v_wf, v_cur FROM workflows
   WHERE organization_id = p_org AND name = p_name AND deleted_at IS NULL;

  IF v_wf IS NULL THEN
    v_wf := 'wf_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO workflows (id, organization_id, name, description, active, created_at, updated_at)
      VALUES (v_wf, p_org, p_name, p_desc, true, now(), now());
    v_ver_id := 'wv_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO workflow_versions (id, organization_id, workflow_id, version, status, definition, published_at, created_at)
      VALUES (v_ver_id, p_org, v_wf, 1, 'PUBLISHED', p_def, now(), now());
    UPDATE workflows SET current_version_id = v_ver_id, active = true, updated_at = now() WHERE id = v_wf;
  ELSIF v_cur IS NOT NULL THEN
    -- Refresca la definición publicada (p. ej. nuevo templateId resuelto) y reactiva.
    UPDATE workflow_versions SET definition = p_def, status = 'PUBLISHED', published_at = now() WHERE id = v_cur;
    UPDATE workflows SET active = true, description = p_desc, updated_at = now() WHERE id = v_wf;
  ELSE
    SELECT COALESCE(MAX(version), 0) + 1 INTO v_ver FROM workflow_versions WHERE workflow_id = v_wf;
    v_ver_id := 'wv_' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO workflow_versions (id, organization_id, workflow_id, version, status, definition, published_at, created_at)
      VALUES (v_ver_id, p_org, v_wf, v_ver, 'PUBLISHED', p_def, now(), now());
    UPDATE workflows SET current_version_id = v_ver_id, active = true, updated_at = now() WHERE id = v_wf;
  END IF;
  RAISE NOTICE 'Workflow "%" publicado y activo.', p_name;
END $fn$;

DO $$
DECLARE
  v_org text;
  v_tpl_rec text;
  v_tpl_ns text;
  v_tpl_tr text;
BEGIN
  SELECT id INTO v_org FROM organizations
   WHERE slug = 'digital-dent' OR name ILIKE '%digital%dent%'
   ORDER BY created_at ASC LIMIT 1;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'No se encontró la org piloto (digital-dent).';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM agents WHERE organization_id = v_org AND slug = 'agendamiento') THEN
    RAISE EXCEPTION 'Falta el agente "agendamiento". Corre antes seed-agendamiento-agent.sql.';
  END IF;

  SELECT id INTO v_tpl_rec FROM whatsapp_templates WHERE organization_id = v_org AND name = 'recordatorio_cita'      AND status = 'APPROVED' LIMIT 1;
  SELECT id INTO v_tpl_ns  FROM whatsapp_templates WHERE organization_id = v_org AND name = 'recaptura_noshow'       AND status = 'APPROVED' LIMIT 1;
  SELECT id INTO v_tpl_tr  FROM whatsapp_templates WHERE organization_id = v_org AND name = 'recaptura_tratamiento'  AND status = 'APPROVED' LIMIT 1;

  -- A) Recordatorio de cita (24 h antes) → confirma / reagenda con el agente.
  IF v_tpl_rec IS NOT NULL THEN
    PERFORM pg_temp.seed_wf(v_org, 'Recordatorio de cita',
      'Recuerda la cita 24 h antes; si el paciente responde, el agente de agendamiento confirma o reagenda.',
      jsonb_build_object(
        'trigger', jsonb_build_object('type','appointment_upcoming','config', jsonb_build_object('hoursBefore',24,'avoidOffHours',true)),
        'variables', '{}'::jsonb,
        'nodes', jsonb_build_array(
          jsonb_build_object('id','n1','type','send_template','config', jsonb_build_object('templateId', v_tpl_rec)),
          jsonb_build_object('id','n2','type','wait_reply','config', jsonb_build_object('hours',48)),
          jsonb_build_object('id','n3','type','switch_agent','config', jsonb_build_object('agentSlug','agendamiento'))
        ),
        'edges', jsonb_build_array(
          jsonb_build_object('from','n1','to','n2'),
          jsonb_build_object('from','n2','to','n3','when','replied')
        )
      ));
  ELSE
    RAISE NOTICE 'OMITIDO "Recordatorio de cita": falta la plantilla APPROVED "recordatorio_cita".';
  END IF;

  -- B) Recaptura no-show → a la mañana siguiente, solo pacientes nuevos, reagendar.
  --    n0 wait 12 h: el no-show lo marca Cláriva de tarde/noche → cae la mañana siguiente
  --    (aproximación del "día siguiente ~10:00"; no existe primitiva "esperar hasta hora X").
  IF v_tpl_ns IS NOT NULL THEN
    PERFORM pg_temp.seed_wf(v_org, 'Recaptura no-show',
      'Si el paciente nuevo no asiste, a la mañana siguiente le ofrece reagendar su evaluación.',
      jsonb_build_object(
        'trigger', jsonb_build_object('type','no_show','config','{}'::jsonb),
        'variables', '{}'::jsonb,
        'nodes', jsonb_build_array(
          jsonb_build_object('id','n0','type','wait','config', jsonb_build_object('hours',12)),
          jsonb_build_object('id','n1','type','condition','config', jsonb_build_object('kind','patient_is_new','maxCompleted',2)),
          jsonb_build_object('id','n2','type','send_template','config', jsonb_build_object('templateId', v_tpl_ns)),
          jsonb_build_object('id','n3','type','wait_reply','config', jsonb_build_object('hours',72)),
          jsonb_build_object('id','n4','type','switch_agent','config', jsonb_build_object('agentSlug','agendamiento'))
        ),
        'edges', jsonb_build_array(
          jsonb_build_object('from','n0','to','n1'),
          jsonb_build_object('from','n1','to','n2','when','true'),
          jsonb_build_object('from','n2','to','n3'),
          jsonb_build_object('from','n3','to','n4','when','replied')
        )
      ));
  ELSE
    RAISE NOTICE 'OMITIDO "Recaptura no-show": falta la plantilla APPROVED "recaptura_noshow".';
  END IF;

  -- C) Recaptura tratamiento → motivar a iniciar el plan, solo pacientes nuevos.
  IF v_tpl_tr IS NOT NULL THEN
    PERFORM pg_temp.seed_wf(v_org, 'Recaptura tratamiento',
      'Si el paciente nuevo asistió pero no inició su tratamiento, lo motiva a retomarlo y agendar.',
      jsonb_build_object(
        'trigger', jsonb_build_object('type','treatment_pending','config','{}'::jsonb),
        'variables', '{}'::jsonb,
        'nodes', jsonb_build_array(
          jsonb_build_object('id','n1','type','condition','config', jsonb_build_object('kind','patient_is_new','maxCompleted',2)),
          jsonb_build_object('id','n2','type','send_template','config', jsonb_build_object('templateId', v_tpl_tr)),
          jsonb_build_object('id','n3','type','wait_reply','config', jsonb_build_object('hours',72)),
          jsonb_build_object('id','n4','type','switch_agent','config', jsonb_build_object('agentSlug','agendamiento'))
        ),
        'edges', jsonb_build_array(
          jsonb_build_object('from','n1','to','n2','when','true'),
          jsonb_build_object('from','n2','to','n3'),
          jsonb_build_object('from','n3','to','n4','when','replied')
        )
      ));
  ELSE
    RAISE NOTICE 'OMITIDO "Recaptura tratamiento": falta la plantilla APPROVED "recaptura_tratamiento".';
  END IF;
END $$;
