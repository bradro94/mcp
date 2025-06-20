import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.json({ 
      status: 'Monday.com MCP Server on Vercel', 
      timestamp: new Date().toISOString(),
      token_configured: !!process.env.MONDAY_TOKEN,
      version: '1.0.0'
    });
  }

  if (req.method === 'POST') {
    const MONDAY_TOKEN = process.env.MONDAY_TOKEN;
    
    if (!MONDAY_TOKEN) {
      return res.status(500).json({
        jsonrpc: "2.0",
        id: req.body?.id || null,
        error: {
          code: -32001,
          message: "Monday.com token not configured"
        }
      });
    }

    const mcpRequest = req.body;
    console.log('Received MCP request:', mcpRequest);

    return new Promise((resolve) => {
      // Try to find the Monday MCP binary in node_modules
      const mcpCommand = 'node';
      const mcpArgs = [
        '-e', 
        `
        const { spawn } = require('child_process');
        
        // Try different ways to find the Monday MCP
        let mcpProcess;
        
        try {
          // First try the global installed version
          mcpProcess = spawn('monday-api-mcp', ['-t', '${MONDAY_TOKEN}'], {
            stdio: ['pipe', 'pipe', 'pipe']
          });
        } catch (e1) {
          try {
            // Try npx if available
            mcpProcess = spawn('npx', ['@mondaydotcomorg/monday-api-mcp', '-t', '${MONDAY_TOKEN}'], {
              stdio: ['pipe', 'pipe', 'pipe']
            });
          } catch (e2) {
            try {
              // Try direct node execution
              mcpProcess = spawn('node', ['node_modules/@mondaydotcomorg/monday-api-mcp/dist/index.js', '-t', '${MONDAY_TOKEN}'], {
                stdio: ['pipe', 'pipe', 'pipe']
              });
            } catch (e3) {
              console.error('Failed to start MCP server:', e3);
              process.exit(1);
            }
          }
        }
        
        // Pipe stdin to the MCP process
        process.stdin.pipe(mcpProcess.stdin);
        
        // Handle output
        mcpProcess.stdout.on('data', (data) => {
          process.stdout.write(data);
        });
        
        mcpProcess.stderr.on('data', (data) => {
          process.stderr.write(data);
        });
        
        mcpProcess.on('close', (code) => {
          process.exit(code);
        });
        
        mcpProcess.on('error', (error) => {
          console.error('MCP process error:', error);
          process.exit(1);
        });
        `
      ];

      const wrapper = spawn(mcpCommand, mcpArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 25000,
        env: {
          ...process.env,
          MONDAY_TOKEN: MONDAY_TOKEN
        }
      });

      // Send the MCP request
      wrapper.stdin.write(JSON.stringify(mcpRequest) + '\n');
      wrapper.stdin.end();

      let stdout = '';
      let stderr = '';

      wrapper.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      wrapper.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error('MCP stderr:', data.toString());
      });

      wrapper.on('close', (code) => {
        console.log('MCP wrapper closed with code:', code);
        console.log('stdout:', stdout);

        if (code !== 0) {
          res.status(500).json({
            jsonrpc: "2.0",
            id: mcpRequest.id,
            error: {
              code: -32603,
              message: "MCP server error",
              data: { 
                exit_code: code, 
                stderr: stderr.slice(-500)
              }
            }
          });
          return resolve();
        }

        try {
          // Parse the MCP response
          const lines = stdout.trim().split('\n');
          let jsonResponse = null;
          
          // Find the last valid JSON line
          for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line.startsWith('{') && line.endsWith('}')) {
              try {
                jsonResponse = JSON.parse(line);
                break;
              } catch (e) {
                continue;
              }
            }
          }

          if (jsonResponse) {
            res.json(jsonResponse);
          } else {
            res.json({
              jsonrpc: "2.0",
              id: mcpRequest.id,
              result: {
                message: "No valid JSON response found",
                raw_output: stdout.slice(-1000)
              }
            });
          }
        } catch (parseError) {
          console.error('JSON parse error:', parseError);
          res.json({
            jsonrpc: "2.0",
            id: mcpRequest.id,
            error: {
              code: -32700,
              message: "Parse error",
              data: parseError.message
            }
          });
        }
        resolve();
      });

      wrapper.on('error', (error) => {
        console.error('Wrapper spawn error:', error);
        res.status(500).json({
          jsonrpc: "2.0",
          id: mcpRequest.id,
          error: {
            code: -32603,
            message: "Failed to start MCP wrapper",
            data: error.message
          }
        });
        resolve();
      });
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
