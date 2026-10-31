import {z} from 'zod';
import {CurrentMandiQuotes} from './market-quotes';
import {ModelInvocation} from './common';
import {PreviousHarvest,CropCycle,FarmWorkspace} from './workspace';
const text=z.string().max(1000);
export const PlanningEvidence=z.object({id:z.string(),title:z.string(),url:z.url(),scope:z.enum(['district','state','region','national']),geographyIds:z.array(z.string()),reviewStatus:z.enum(['source_checked','pending']),limitations:z.array(text)}).strict();
export const PlanningProposal=z.object({id:z.string(),cropId:z.string(),productId:z.string(),cropName:z.string(),productName:z.string(),season:z.string(),plannedSowingDate:z.iso.date(),plannedHarvestDate:z.iso.date(),harvestWindow:z.object({earliest:z.iso.date(),latest:z.iso.date()}).strict(),scope:z.enum(['district','state','region','national']),reason:text,evidenceRefs:z.array(z.string()),uncertainties:z.array(text),conditional:z.boolean()}).strict();
export const PlanningComparison=z.object({candidateId:z.string(),cropId:z.string(),productId:z.string(),cropName:z.string(),productName:z.string(),rank:z.number().int().positive(),reason:text,evidenceRefs:z.array(z.string()),uncertainties:z.array(text),scope:z.enum(['district','state','region','national']),nextSowingDate:z.iso.date(),sowingWindow:z.object({from:z.iso.date(),to:z.iso.date()}).strict().nullable(),harvestWindow:z.object({earliest:z.iso.date(),latest:z.iso.date()}).strict().nullable(),availability:z.enum(['free_window','conflicts_with_existing_plan','unknown_current_harvest'])}).strict();
export const PlanningReview=z.object({
 reviewId:z.uuid().nullable(),jobId:z.uuid().nullable(),contextHash:z.string().nullable(),status:z.enum(['pending','running','partial','ready','unavailable','error']),stale:z.boolean(),inputVersions:z.object({farm:z.number().int(),workspace:z.number().int()}).strict(),generatedAt:z.iso.datetime().nullable(),retryAfter:z.iso.datetime().nullable(),modelInvocation:ModelInvocation.nullable(),summary:text,
 localContext:z.object({
  location:z.object({stateId:z.string().nullable(),districtId:z.string().nullable(),districtName:z.string().nullable(),village:z.string().nullable(),villageBasis:z.enum(['farmer_reported','unavailable']),granularity:z.enum(['district','state','unknown']),sources:z.array(z.string()),limitations:z.array(text)}).strict(),
  weather:z.object({kind:z.literal('forecast'),status:z.enum(['fresh','stale','unavailable']),issuedAt:z.iso.datetime().nullable(),source:z.string(),days:z.array(z.object({date:z.iso.date(),rainMm:z.number().nullable(),tMinC:z.number().nullable(),tMaxC:z.number().nullable()}).strict()),limitations:z.array(text)}).strict(),
  mandi:z.object({currentQuotes:CurrentMandiQuotes.optional(),status:z.enum(['available','stale','unavailable']),references:z.array(z.object({productId:z.string(),marketId:z.string(),marketName:z.string(),date:z.iso.date(),inrPerKg:z.string(),source:z.string(),scope:z.string()}).strict()),limitations:z.array(text)}).strict(),
  history:z.object({basis:z.enum(['farmer_reported','illustrative']),previousHarvest:PreviousHarvest,cycles:z.array(CropCycle),rotationAssessment:z.literal('not_assessed')}).strict(),
  occupancy:z.array(z.object({cropId:z.string(),start:z.iso.date(),end:z.iso.date().nullable(),basis:z.enum(['farmer_reported','planned','source_duration_scenario','unknown'])}).strict()),
 }).strict(),horizon:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),rotationDraft:z.array(PlanningProposal).max(6),comparisonShortlist:z.array(PlanningComparison).max(8),evidence:z.array(PlanningEvidence),limitations:z.array(text),appliedProposalIds:z.array(z.string()),
}).strict();
export const ApplyPlanningReview=z.object({reviewId:z.uuid(),proposalIds:z.array(z.string()).min(1).max(6),expectedWorkspaceVersion:z.number().int().nonnegative()}).strict();
export const ApplyPlanningReviewResult=z.object({workspace:FarmWorkspace,review:PlanningReview}).strict();
export type PlanningReview=z.infer<typeof PlanningReview>;
export type PlanningProposal=z.infer<typeof PlanningProposal>;
export type PlanningComparison=z.infer<typeof PlanningComparison>;
export type PlanningEvidence=z.infer<typeof PlanningEvidence>;
