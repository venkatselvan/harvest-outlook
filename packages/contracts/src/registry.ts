import { FieldPhoto, FieldPhotoPrediction, FieldPhotoGallery, FieldPhotoGuidance, SaveFieldPhotos, FieldPhotoCoverage } from "./field-photos";
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
import {CurrentMandiQuotes,CurrentMandiQuote} from './market-quotes';
import {SoilReportedReference,SoilParameter,SoilMarkerDraft,SoilSampleDraft,SoilReportExtraction,SoilCanonicalValue,SoilMarker,SoilReport,ReviewSoilReport,ConfirmSoilReport,FarmSoilMarkers} from './soil-reports';
import {CommodityCatalogue,PricedCommodity,ResearchedCropProfile} from './commodity-catalogue';
import { WaterBalanceInput, WaterBalanceResult } from './water';
import {FarmCommandCenter,PlantCrop,PlantCropResult,CompleteCareTask,CompleteCareTaskResult,FocusedCrop,CareTask,SoilCropFit,PriorYearMarket} from './command-center';
import { TodayView } from './today';
import { FarmSummary } from './farm-summary';
import { MarketTimeline } from './market';
import { CropFitReview } from './crop-fit';
import { SoilReview } from './soil-review';
import { SeasonPreview } from './season-preview';
import { FarmAlert, FarmAlerts } from './alerts';
import { NdviSeries, NeighbourhoodSeasonality } from './ndvi';
import { PriceSeries, HarvestPriceOutlook, PriceTrend } from './price-outlook';
import { StageTimeline, YearPlanReview, YearPlanOption, RescoreYearPlan, ApplyYearPlan, ApplyYearPlanResult } from './year-plan';
import { FutureLookAsset } from './future-look';
import { SeasonReport } from './season-report';

/**
 * Every public contract exported as JSON Schema for Python analytics.
 * Keys become file names under packages/contracts/schema/.
 */
export const PUBLIC_CONTRACTS: Record<string, z.ZodType> = {
  FieldPhoto, FieldPhotoPrediction, FieldPhotoGallery, FieldPhotoGuidance, SaveFieldPhotos, FieldPhotoCoverage,
  TodayView,
  FarmSummary,FarmAlert,FarmAlerts,NdviSeries,NeighbourhoodSeasonality,PriceSeries,HarvestPriceOutlook,PriceTrend,StageTimeline,YearPlanReview,YearPlanOption,RescoreYearPlan,ApplyYearPlan,ApplyYearPlanResult,FutureLookAsset,MarketTimeline,CropFitReview,SoilReview,SeasonPreview,SeasonReport,
  FarmCommandCenter,PlantCrop,PlantCropResult,CompleteCareTask,CompleteCareTaskResult,FocusedCrop,CareTask,SoilCropFit,PriorYearMarket,
  SoilReportedReference,SoilParameter,SoilMarkerDraft,SoilSampleDraft,SoilReportExtraction,SoilCanonicalValue,SoilMarker,SoilReport,ReviewSoilReport,ConfirmSoilReport,FarmSoilMarkers,CommodityCatalogue,PricedCommodity,ResearchedCropProfile,
  CurrentMandiQuotes,
  CurrentMandiQuote,
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
