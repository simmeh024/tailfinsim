-- tailfin:migration-strategy expand
-- Adds the disruption_cost cash cause. Additive: the previous release never
-- writes it, so it keeps working against the result.
ALTER TYPE "public"."cash_movement_cause" ADD VALUE 'disruption_cost' BEFORE 'migration_opening_balance';