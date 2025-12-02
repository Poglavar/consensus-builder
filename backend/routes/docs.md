# API Documentation

This is the API documentation for the Consensus Builder application.

## Documentation Overview

### 📋 `GET /docs/database`

- **Purpose**: machine readable live database schema documentation
- **Content**: Complete table definitions, relationships, API endpoints, and usage guidelines

#### Core Tables

- **`parcel`**: Land parcels with cadastral information
- **`building`**: Building structures and 3D models
- **`street`**: Street/road network
- **`planned_road`**: Planned infrastructure
- **`urban_rule`**: Urban planning regulations
- **`cadastral_municipality`**: Administrative boundaries

### 📋 `GET /docs/api`

- **Purpose**: machine readable live API schema documentation
- **Content**: Complete API schema documentation

#### Main API Endpoints (refer to `GET /docs/api` for more details)

- `GET /parcels` - Land parcel data
- `GET /parcel-ba` - Buenos Aires parcels by parcel, block (manzana), or section
- `GET /parcels/:parcelId/ownership` - Parcel ownership & possession sheets
- `GET /buildings` - Building information
- `GET /objects` - 3D building models
- `GET /planned-road` - Planned infrastructure
- `GET /streets` - Street network
- `GET /urban-rules` - Urban planning rules

#### Key API Features

- **PostGIS Integration**: Full spatial database support
- **Coordinate Systems**: EPSG:3765 (HTRS96/TM) and EPSG:4326 (WGS84)
- **API Endpoints**: RESTful API with GeoJSON responses
- **Spatial Operations**: Advanced geometry operations and queries
- **Blockchain Integration**: NFT support for parcels and proposals

#### API Validation

```javascript
// Validate API requests against schema
const Ajv = require("ajv");
const schema = require("./api-schema.json");
const ajv = new Ajv();
const validate = ajv.compile(schema);
```

## Coordinate Systems

- **EPSG:3765 (HTRS96/TM)**: Primary coordinate system for Croatian data
- **EPSG:4326 (WGS84)**: Global coordinate system for external APIs
- **Automatic Detection**: Coordinate system detection based on value ranges
- **Transformations**: Built-in coordinate transformation support

## Blockchain Integration

- **ParcelNFT**: ERC721 NFT for land parcels
- **ProposalNFT**: ERC721 NFT for urban proposals
- **City Token**: ERC20 token for governance
- **Ownership Tracking**: Blockchain-based ownership verification

## Development Guidelines

- Always use EPSG:3765 for internal operations
- Transform to WGS84 only for external APIs
- Use PostGIS functions for spatial operations
- Implement proper error handling for geometry operations

## Support

- Telegram group: https://t.me/urbangametheory

**Last Updated**: $(date)
**Version**: 1.0.0
**Maintainer**: Consensus Builder Team
