import type {FastifyInstance} from 'fastify';
import type {ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';
import {CommodityCatalogue,ResearchedCropProfile} from '@harvest/contracts';
import type {Pool} from '../db/pool';
import type {Config} from '../config';
import {envelope} from '../envelope';
import {envelopeSchema} from './schemas/common';
import {listSoilTypeReferences,listCommodityCatalogue,getResearchedProfile} from '../services/commodity-catalogue';
export async function commodityCatalogueRoutes(app:FastifyInstance,deps:{pool:Pool;config:Config}){const r=app.withTypeProvider<ZodTypeProvider>();
 r.get('/api/v1/commodities',{schema:{tags:['catalogue'],querystring:z.object({query:z.string().max(200).default(''),grouping:z.string().max(60).optional(),offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(300).default(100)}),response:{200:envelopeSchema(CommodityCatalogue)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await listCommodityCatalogue(deps.pool,{...req.query,grouping:req.query.grouping})));
 r.get('/api/v1/commodity-profiles/:id',{schema:{tags:['catalogue'],params:z.object({id:z.string().min(1).max(200)}),response:{200:envelopeSchema(ResearchedCropProfile)}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await getResearchedProfile(deps.pool,req.params.id)));
 r.get('/api/v1/soil-type-references',{schema:{tags:['catalogue'],response:{200:envelopeSchema(z.object({references:z.array(z.record(z.string(),z.unknown())),limitations:z.array(z.string())}))}}},async req=>envelope(req.id,deps.config.RUNTIME_MODE,await listSoilTypeReferences(deps.pool)));
}
