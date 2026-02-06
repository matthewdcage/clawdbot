import { runReport } from './src/core/ga4-reporting';
import { authenticate } from './src/config/auth';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });


async function getReportData() {
  try {
    const auth = authenticate();
    const result = await runReport(auth, {
      propertyId: '322712302',
      dateRanges: [{ startDate: '2026-01-01', endDate: '2026-01-31' }],
      metrics: [{ name: 'purchaseRevenue' }, { name: 'sessions' }, { name: 'conversions' }],
      dimensions: [{ name: 'newVsReturning' }, { name: 'sessionDefaultChannelGroup' }],
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Error fetching GA4 data:', error);
  }
}

getReportData();
