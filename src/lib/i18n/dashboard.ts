import type { Namespace } from './index'

// 'dashboard' namespace — keys used as t('dashboard.<key>'). Keep en and ur in sync
// (the `ur` object is typed against `en`, so a missing key fails the typecheck).
const en = {
  title: 'Alerts dashboard',
  adminTitle: 'All alerts',
  adminSubtitle: 'Admin view — every organisation',

  // org gate
  noOrgTitle: 'Register your organisation',
  noOrgBody: 'Add your NGO or service and its area. Reports from people nearby will then reach you here instantly.',
  registerOrg: 'Register organisation',
  pendingTitle: 'Waiting for approval',
  pendingBody: 'An admin is checking your organisation. Alerts will start arriving here as soon as it is approved.',
  pendingShort: 'pending',
  pendingSome: 'Waiting for approval: {names}',
  checkAgain: 'Check again',

  // org context
  orgFilter: 'Organisation',
  allOrgs: 'All organisations',
  allMyOrgs: 'All my organisations',
  serviceRadius: '{km} service area',
  serviceAreaOf: 'Service area: {name}',
  orgType_shelter: 'Shelter',
  orgType_food_bank: 'Food bank',
  orgType_health_ngo: 'Health NGO',
  orgType_rescue_1122: 'Rescue 1122',
  orgType_fire: 'Fire brigade',
  orgType_police: 'Police',
  orgType_water: 'Water authority',

  // device controls
  live: 'Live',
  connecting: 'Connecting…',
  offlineRetry: 'Offline — retrying',
  refresh: 'Refresh',
  soundOn: 'Alert sound on',
  soundOff: 'Alert sound off',
  enableAlerts: 'Enable alerts on this device',
  alertsOn: 'Alerts on',
  alertsDenied: 'Alerts blocked — allow notifications in browser settings',
  alertsError: 'Could not enable alerts — tap to retry',

  // stats
  statOpen: 'New',
  statClaimed: 'Claimed',
  statInProgress: 'In progress',
  statResolvedToday: 'Resolved today',
  statAvgClaim: 'Avg. time to claim',

  // views / tabs / filters
  viewList: 'List',
  viewMap: 'Map',
  tabNew: 'New',
  tabActive: 'Active',
  tabDone: 'Done',
  allCategories: 'All',
  emptyNew: 'No new alerts',
  emptyNewBody: 'New reports in your area will appear here instantly, with a sound.',
  emptyActive: 'Nothing in progress',
  emptyActiveBody: 'Alerts you claim move here.',
  emptyDone: 'Nothing resolved yet',
  emptyDoneBody: 'Resolved alerts and how long they took appear here.',
  loadError: 'Could not load alerts',

  // card
  newBadge: 'NEW',
  unconfirmedEarly: 'UNCONFIRMED — routed early (high urgency)',
  servings: '{n} servings',
  safeFor: 'Safe for {time}',
  foodExpired: 'Food expired',
  claimedByOther: 'Already claimed by {org}',
  claim: 'Claim',
  start: 'Start work',
  resolve: 'Mark resolved',
  resolvedIn: 'Resolved in {time}',
  resolvedLabel: 'Resolved',
  directions: 'Directions',

  // action results / toasts
  done_claim: 'Claimed — the reporters have been told help is coming',
  done_start: 'Work started — reporters updated',
  done_resolve: 'Marked resolved — thank you!',
  actionFailed: 'Could not update. Check your connection and try again.',
  newAlert: 'New alert: {title}',
  moreNew: '+{n} more new alerts',
  tapToOpen: 'Tap to open',

  // map
  mapUnavailable: 'Map unavailable',
  mapNoKey: 'Add a Google Maps API key to show the map. The list still works.',
  mapLoadError: 'The map could not load. The list still works.',

  // durations
  durMin: '{m} min',
  durHourMin: '{h} h {m} min',
  durDayHour: '{d} d {h} h',
}

const ur: Record<keyof typeof en, string> = {
  title: 'الرٹس ڈیش بورڈ',
  adminTitle: 'تمام الرٹس',
  adminSubtitle: 'ایڈمن منظر — تمام تنظیمیں',

  noOrgTitle: 'اپنی تنظیم رجسٹر کریں',
  noOrgBody: 'اپنی تنظیم یا سروس اور اس کا علاقہ شامل کریں۔ پھر قریبی لوگوں کی رپورٹس فوراً یہاں پہنچیں گی۔',
  registerOrg: 'تنظیم رجسٹر کریں',
  pendingTitle: 'منظوری کا انتظار',
  pendingBody: 'ایڈمن آپ کی تنظیم کی جانچ کر رہا ہے۔ منظوری ملتے ہی الرٹس یہاں آنا شروع ہو جائیں گے۔',
  pendingShort: 'زیرِ غور',
  pendingSome: 'منظوری کا انتظار: {names}',
  checkAgain: 'دوبارہ دیکھیں',

  orgFilter: 'تنظیم',
  allOrgs: 'تمام تنظیمیں',
  allMyOrgs: 'میری تمام تنظیمیں',
  serviceRadius: '{km} سروس علاقہ',
  serviceAreaOf: 'سروس علاقہ: {name}',
  orgType_shelter: 'پناہ گاہ',
  orgType_food_bank: 'فوڈ بینک',
  orgType_health_ngo: 'صحت کی تنظیم',
  orgType_rescue_1122: 'ریسکیو 1122',
  orgType_fire: 'فائر بریگیڈ',
  orgType_police: 'پولیس',
  orgType_water: 'واٹر اتھارٹی',

  live: 'لائیو',
  connecting: 'رابطہ ہو رہا ہے…',
  offlineRetry: 'آف لائن — دوبارہ کوشش جاری',
  refresh: 'تازہ کریں',
  soundOn: 'الرٹ کی آواز آن',
  soundOff: 'الرٹ کی آواز بند',
  enableAlerts: 'اس فون پر الرٹس آن کریں',
  alertsOn: 'الرٹس آن ہیں',
  alertsDenied: 'الرٹس بند ہیں — براؤزر سیٹنگز میں نوٹیفیکیشن کی اجازت دیں',
  alertsError: 'الرٹس آن نہیں ہو سکے — دوبارہ دبائیں',

  statOpen: 'نئے',
  statClaimed: 'ذمہ لیے',
  statInProgress: 'کام جاری',
  statResolvedToday: 'آج حل ہوئے',
  statAvgClaim: 'ذمہ لینے کا اوسط وقت',

  viewList: 'فہرست',
  viewMap: 'نقشہ',
  tabNew: 'نئے',
  tabActive: 'جاری',
  tabDone: 'مکمل',
  allCategories: 'سب',
  emptyNew: 'کوئی نیا الرٹ نہیں',
  emptyNewBody: 'آپ کے علاقے کی نئی رپورٹس آواز کے ساتھ فوراً یہاں آئیں گی۔',
  emptyActive: 'کوئی کام جاری نہیں',
  emptyActiveBody: 'جو الرٹس آپ ذمہ لیں گے وہ یہاں آئیں گے۔',
  emptyDone: 'ابھی کچھ حل نہیں ہوا',
  emptyDoneBody: 'حل شدہ الرٹس اور ان پر لگا وقت یہاں نظر آئے گا۔',
  loadError: 'الرٹس لوڈ نہیں ہو سکے',

  newBadge: 'نیا',
  unconfirmedEarly: 'غیر تصدیق شدہ — زیادہ فوری ہونے کی وجہ سے پہلے بھیجا گیا',
  servings: '{n} افراد کا کھانا',
  safeFor: '{time} تک محفوظ',
  foodExpired: 'کھانا خراب ہونے کا وقت گزر گیا',
  claimedByOther: '{org} پہلے ہی ذمہ لے چکی ہے',
  claim: 'ذمہ لیں',
  start: 'کام شروع کریں',
  resolve: 'حل ہو گیا',
  resolvedIn: '{time} میں حل ہوا',
  resolvedLabel: 'حل ہو گیا',
  directions: 'راستہ',

  done_claim: 'ذمہ لے لیا — رپورٹ کرنے والوں کو بتا دیا گیا کہ مدد آ رہی ہے',
  done_start: 'کام شروع — رپورٹ کرنے والوں کو اطلاع دے دی گئی',
  done_resolve: 'حل شدہ — شکریہ!',
  actionFailed: 'تبدیلی محفوظ نہیں ہو سکی۔ انٹرنیٹ دیکھیں اور دوبارہ کوشش کریں۔',
  newAlert: 'نیا الرٹ: {title}',
  moreNew: '+{n} مزید نئے الرٹس',
  tapToOpen: 'کھولنے کے لیے دبائیں',

  mapUnavailable: 'نقشہ دستیاب نہیں',
  mapNoKey: 'نقشہ دکھانے کے لیے Google Maps کی کلید شامل کریں۔ فہرست کام کر رہی ہے۔',
  mapLoadError: 'نقشہ لوڈ نہیں ہو سکا۔ فہرست کام کر رہی ہے۔',

  durMin: '{m} منٹ',
  durHourMin: '{h} گھنٹے {m} منٹ',
  durDayHour: '{d} دن {h} گھنٹے',
}

export default { en, ur } satisfies Namespace
