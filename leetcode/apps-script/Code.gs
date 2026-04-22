var COLUMN_HEADERS = [
  'Problem Number',
  'Problem Title',
  'Problem Description',
  'Difficulty',
  'Tags',
  'Language',
  'Runtime',
  'Memory',
  'LeetCode URL',
  'Walkthrough',
  'Key Insights',
  'Mistakes / Blockers',
  'Confidence',
  'Revisit',
  'Submitted At'
];

function doPost(e) {
  try {
    var properties = PropertiesService.getScriptProperties();
    var configuredSecret = String(properties.getProperty('LEETCODE_SHARED_SECRET') || '').trim();
    var spreadsheetId = String(properties.getProperty('LEETCODE_SPREADSHEET_ID') || '').trim();
    var defaultSheetName = String(properties.getProperty('LEETCODE_DEFAULT_SHEET_NAME') || 'LeetCode Log').trim() || 'LeetCode Log';
    var providedSecret = getSharedSecret_(e);

    if (!configuredSecret) {
      throw new Error('Missing LEETCODE_SHARED_SECRET script property.');
    }

    if (!spreadsheetId) {
      throw new Error('Missing LEETCODE_SPREADSHEET_ID script property.');
    }

    if (providedSecret !== configuredSecret) {
      return jsonResponse_({ ok: false, error: 'Invalid shared secret.' });
    }

    var payload = parsePayload_(e);
    var record = payload.record;

    if (!record || typeof record !== 'object') {
      throw new Error('Request body must include a record object.');
    }

    var targetSheetName = String(payload.sheetName || '').trim() || defaultSheetName;
    var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    var ensured = ensureSheetStructure_(spreadsheet, targetSheetName);

    ensured.sheet.appendRow(recordToRow_(record));

    return jsonResponse_({
      ok: true,
      sheetNameUsed: targetSheetName,
      createdSheet: ensured.createdSheet,
      createdHeaders: ensured.createdHeaders
    });
  } catch (error) {
    return jsonResponse_({ ok: false, error: error.message || 'Unknown Apps Script error.' });
  }
}

function getSharedSecret_(e) {
  if (e && e.parameter && e.parameter.sharedSecret) {
    return String(e.parameter.sharedSecret).trim();
  }

  if (e && e.postData && e.postData.contents) {
    try {
      var body = JSON.parse(e.postData.contents);
      if (body && body.sharedSecret) {
        return String(body.sharedSecret).trim();
      }
    } catch (error) {
      // Ignore here. parsePayload_ handles invalid JSON later.
    }
  }

  return '';
}

function parsePayload_(e) {
  var rawBody = e && e.postData ? String(e.postData.contents || '').trim() : '';

  if (!rawBody) {
    throw new Error('Request body is required.');
  }

  try {
    return JSON.parse(rawBody);
  } catch (error) {
    throw new Error('Request body must be valid JSON.');
  }
}

function ensureSheetStructure_(spreadsheet, sheetName) {
  var sheet = spreadsheet.getSheetByName(sheetName);
  var createdSheet = false;
  var createdHeaders = false;

  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    createdSheet = true;
  }

  var headerRange = sheet.getRange(1, 1, 1, COLUMN_HEADERS.length);
  var existingHeaders = headerRange.getValues()[0];

  if (!headersMatch_(existingHeaders, COLUMN_HEADERS)) {
    headerRange.setValues([COLUMN_HEADERS]);
    createdHeaders = true;
  }

  return {
    sheet: sheet,
    createdSheet: createdSheet,
    createdHeaders: createdHeaders
  };
}

function headersMatch_(actualHeaders, expectedHeaders) {
  if (!actualHeaders || actualHeaders.length < expectedHeaders.length) {
    return false;
  }

  for (var index = 0; index < expectedHeaders.length; index += 1) {
    if (String(actualHeaders[index] || '').trim() !== expectedHeaders[index]) {
      return false;
    }
  }

  return true;
}

function recordToRow_(record) {
  return [
    stringValue_(record.problemNumber),
    stringValue_(record.problemTitle),
    stringValue_(record.problemDescription),
    stringValue_(record.difficulty),
    joinTags_(record.tags),
    stringValue_(record.language),
    stringValue_(record.runtime),
    stringValue_(record.memory),
    stringValue_(record.leetcodeUrl),
    stringValue_(record.walkthrough),
    stringValue_(record.keyInsights),
    stringValue_(record.mistakes),
    stringValue_(record.confidence),
    record.revisit ? 'Yes' : 'No',
    stringValue_(record.submittedAt)
  ];
}

function joinTags_(tags) {
  return Array.isArray(tags) ? tags.join(', ') : stringValue_(tags);
}

function stringValue_(value) {
  return value == null ? '' : String(value);
}

function jsonResponse_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}