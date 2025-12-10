# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- **Test & Lint**: `npm test` - Runs ESLint and test suite with coverage (requires coverage threshold)
- **Lint Only**: `npx eslint` - Run ESLint using neostandard configuration
- **Coverage Check**: Tests require coverage check to pass via borp

## Architecture Overview

This is an Undici interceptor that enables routing HTTP requests to worker threads with load balancing and mesh networking capabilities.

### Core Components

1. **ThreadInterceptor** (`index.js:7-10`) - Main entry point that creates and coordinates the system
2. **Interceptor** (`lib/interceptor.js`) - Handles domain matching and request routing decisions
3. **Coordinator** (`lib/coordinator.js`) - Manages routes and MessageChannel communication between threads
4. **RoundRobin** (`lib/roundrobin.js`) - Implements load balancing across worker threads for same hostname
5. **Wire** (`lib/wire.js`) - Configures worker threads to receive and process requests

### Key Architecture Patterns

- **Domain-based Routing**: Requests are routed based on hostname matching a configured domain suffix (e.g., `.local`)
- **Round-robin Load Balancing**: Multiple workers can serve the same hostname with automatic load distribution. Only ready workers are selected.
- **Mesh Networking**: All worker threads can communicate with each other via MessageChannels
- **Zero-copy Streaming**: Large payloads use MessagePort transfers to avoid memory copying

### Request Flow

1. Client makes request to `hostname.domain` (e.g., `api.local`)
2. Interceptor checks if hostname ends with configured domain
3. If matched, finds route and selects next **ready** worker via round-robin (workers with `kReady = true`)
4. If no ready worker is available, returns an error
5. Creates MessageChannel and sends serialized request to worker
6. Worker processes request (either locally or via network proxy)
7. Response is sent back through MessageChannel to client

### Worker Configuration

Workers use `wire()` function from `index.js:12-15` to:
- Accept either HTTP server instances or network URLs as targets
- Configure hooks for request/response lifecycle
- Handle graceful shutdown via `interceptor.close()`

### Testing Framework

- Uses `borp` test runner with coverage requirements
- Tests located in `test/` directory with comprehensive fixture support
- ESLint configured via `neostandard` for code quality

### Key Files

- `lib/common.js` - Shared utilities for route management (addRoute, removeRoute, updateRoute)
- `lib/coordinator.js` - Main thread route coordination, handles MESSAGE_WIRE and mesh setup
- `lib/wire.js` - Worker thread setup, responds to MESSAGE_WIRE with readiness state
- `lib/roundrobin.js` - Load balancer that only selects ready workers (kReady check)
- `lib/message-port-streams.js` - MessagePort stream implementations
- `lib/utils.js` - Core constants and utility functions
- `lib/hooks.js` - Hook system for request/response lifecycle
