# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Tide and water level stations of the Canadian Hydrographic Service (IWLS
  API): predicted level, next high and low tides (height, time in station
  time, minutes left), observed level, time of the observation, gap between
  the observation and the prediction.
- Scene trigger "High or low tide (Marées Canada)": 3 h, 2 h, 1 h, 30 or
  15 minutes before a predicted tide, or at the tide; once per tide, at most
  10 minutes late.
- "Test the stations" and "Search stations" buttons.
- One request at a time, 6 s apart (10 a minute, a third of the API's limit);
  the 429 pause and the instant of every read kept in `/data`; a failed read
  retried after 2, 4, 8... minutes; a silent tide gauge, a station without a
  15-minute curve and unclassified tides said in the status, never published
  as 0.
- The state file written asynchronously (a frozen `/data` never freezes the
  integration); a corrupt one set aside as `.bad`.
- Using the integration means accepting the CHS licence agreement (said in
  the configuration and the docs); tests on synthetic answers only.
