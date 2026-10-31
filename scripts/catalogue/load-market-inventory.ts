import '../../apps/api/src/env';
import {createPool} from '../../apps/api/src/db/pool';
import {loadConfig} from '../../apps/api/src/config';
import {importCommodityCatalogue} from '../../apps/api/src/services/commodity-catalogue';
const pool=createPool(loadConfig().DATABASE_URL);try{console.log(JSON.stringify(await importCommodityCatalogue(pool)))}finally{await pool.end()}
