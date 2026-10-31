import type {FastifyInstance} from 'fastify';
import {envelope} from '../envelope';
import type {Config} from '../config';
import {loadMarketContext,FAO_MARKET_URL,type MarketContext} from '../services/market-context';
/** Public global bulletin; never accepts user text, farm coordinates or a caller-controlled URL. */
export async function registerMarketContextRoutes(app:FastifyInstance,deps:{config:Config}){
 app.get('/api/v1/market-context',async(req,reply)=>{reply.header('cache-control','public, max-age=300');const unavailable:MarketContext={status:'unavailable',fetchedAt:null,publishedAt:null,period:null,source:{name:'FAO Food Price Index · monthly market bulletin',url:FAO_MARKET_URL},indices:[],topics:[],limitations:['Global market context is fetched only in live mode.']};return envelope(req.id,deps.config.RUNTIME_MODE,deps.config.RUNTIME_MODE==='live'?await loadMarketContext():unavailable);});
}
