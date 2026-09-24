import {makeBudgetedSearch} from './searchBudget.js';
import {assertLibrary} from './libraryValidation.js';
export const DISCOVERY_TEST_LIMIT=100;
// Separate user-authorized lifetime allowance. Never resets with the month/key.
// Count all persisted reservations, including failed/free/unknown requests.
export function makeDiscoveryTestBudget({initialState,persist,request}){
 const budget=makeBudgetedSearch({initialState,persist,request});
 let tail=Promise.resolve();
 const allowance=()=>({limit:DISCOVERY_TEST_LIMIT,used:budget.state().requests.length,remaining:Math.max(0,DISCOVERY_TEST_LIMIT-budget.state().requests.length)});
 return {state:budget.state,allowance,run(options){
  const task=tail.then(()=>{
   assertLibrary(options.provider==='zhipu','Discovery test is Pro-only');
   if(!allowance().remaining)return {called:false,reason:'test_quota_exhausted'};
   // This exception applies only to the isolated test ledger, never production.
   return budget.run({...options,zhipuMonthlyLimit:null});
  });tail=task.catch(()=>{});return task;
 }};
}
