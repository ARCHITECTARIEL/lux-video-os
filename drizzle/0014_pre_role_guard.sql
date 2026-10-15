DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE role NOT IN ('customer', 'tester', 'workspace', 'ceo')) THEN
    RAISE EXCEPTION 'users.role has unexpected values; reconcile first';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_role_ck CHECK (role IN ('customer', 'tester', 'workspace', 'ceo'));
--> statement-breakpoint
CREATE FUNCTION users_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.role NOT IN ('customer', 'tester')
    AND current_setting('lux.role_write', true) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'users.role % requires privileged write', NEW.role;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role
    AND current_setting('lux.role_write', true) IS DISTINCT FROM 'admin' THEN
    RAISE EXCEPTION 'users.role change requires privileged write';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER users_role_guard_tg BEFORE INSERT OR UPDATE OF role ON users
FOR EACH ROW EXECUTE FUNCTION users_role_guard();
