import bpy
import addon_utils

# Enable the MCP addon
addon_utils.enable("mcp", default_set=True)

# Start the MCP server by toggling the property
# The MCP addon registers a server that listens on a port
try:
    bpy.ops.preferences.addon_enable(module="mcp")
except:
    pass

# Try to start the server via the operator if available
for attr in dir(bpy.ops):
    if 'mcp' in attr.lower():
        print(f"Found MCP ops module: {attr}")

# The addon should auto-start its server
print("MCP addon load attempted. Checking registered addons...")
for mod in addon_utils.modules():
    if 'mcp' in mod.__name__.lower():
        print(f"  Found: {mod.__name__}")
