# Third-party notices

The code of this integration is licensed under the Apache License 2.0 (see
`LICENSE`). It was written from the published OpenAPI description of the
IWLS API (`https://api-iwls.dfo-mpo.gc.ca/v3/api-docs`); no third-party code
is included. It reads public data, credited below.

## Data of the Canadian Hydrographic Service

The tide predictions, high and low tides, observed water levels, station
names and metadata come from the IWLS API (Integrated Water Level System) of
the Canadian Hydrographic Service (CHS), Fisheries and Oceans Canada, used
under the CHS licence agreement:
https://www.tides.gc.ca/en/licence-agreement (French:
https://www.marees.gc.ca/fr/accord-de-licence). That licence is not the Open
Government Licence: the Data is not to be used for navigation nor for
commercial derivative products, and a derivative product carries this notice:

> This product is not to be used for navigation. This product was made by or for the User [the gladys-marees-canada project] and contains intellectual property (Data) of the Canadian Hydrographic Service of the Department of Fisheries and Oceans. The copyrights in the Data are and remain the property of His Majesty the King in Right of Canada and shall not be sold, licensed, leased, assigned or given to a third party. The incorporation of the Data in this product does not constitute an endorsement or an approval of this product by the Canadian Hydrographic Service, the Department of Fisheries and Oceans or His Majesty the King in Right of Canada.

No CHS Data is kept in this repository nor in the image: the files of
`test/fixtures/` are synthetic answers of the same shape (invented stations,
codes, ids, notices and heights, written by `.github/scripts/fixtures.mjs`),
covered by the Apache License like the code. Each installation reads the
Data from the API at run time, as the User of the licence above.
