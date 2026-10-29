import type { z } from 'zod';
import { ApiError, DateRange, GeoPoint, SpatialScope, Unit } from './common';
import { CoverageRecord } from './coverage';
import { EconomicsInput, EconomicsResult } from './economics';
import { EvidenceRecord, ValueRecord } from './evidence';
import { FarmProfile } from './farm';
import { CropIdentity, CropProduct, DistrictRef, MarketRef } from './identity';
import { Job, PriceTable, UsageLedgerEntry, UsageReservation } from './jobs';
import { ActionTask, AgentTrace, ForecastArtifact, JournalEntry, JournalFact, PlanSnapshot, StageDefinition, VisualAsset } from './plans';
import { CropRule, RuleContext, RuleEvaluationResult } from './rules';
import { StructuredAssistantOutput, ToolSchemas } from './assistant';
import { WaterBalanceInput, WaterBalanceResult } from './water';

/**
 * Every public contract exported as JSON Schema for Python analytics.
 * Keys become file names under packages/contracts/schema/.
 */
export const PUBLIC_CONTRACTS: Record<string, z.ZodType> = {
  ApiError,
  DateRange,
  GeoPoint,
  SpatialScope,
  Unit,
  EvidenceRecord,
  ValueRecord,
  CropIdentity,
  CropProduct,
  DistrictRef,
  MarketRef,
  CoverageRecord,
  CropRule,
  RuleContext,
  RuleEvaluationResult,
  FarmProfile,
  StageDefinition,
  PlanSnapshot,
  ActionTask,
  ForecastArtifact,
  JournalEntry,
  JournalFact,
  VisualAsset,
  AgentTrace,
  StructuredAssistantOutput,
  EconomicsInput,
  EconomicsResult,
  WaterBalanceInput,
  WaterBalanceResult,
  Job,
  UsageReservation,
  UsageLedgerEntry,
  PriceTable,
  ...Object.fromEntries(
    Object.entries(ToolSchemas).flatMap(([name, s]) => [
      [`tool.${name}.input`, s.input],
      [`tool.${name}.output`, s.output],
    ]),
  ),
};
