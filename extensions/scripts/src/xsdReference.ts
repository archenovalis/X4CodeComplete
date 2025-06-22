import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { logger } from './logger';
import { log } from 'console';

/**
 * Represents attributes of an element, including its parent name and a map of attributes.
 * This is used to store attributes for elements in a structured way.
 */
export class AttributeOfElement {
  parentName: string;
  attributes: Map<string, object>;
  constructor(parentName: string = '', attributes: Map<string, object> = new Map()) {
    this.parentName = parentName;
    this.attributes = attributes;
  }
}

/**
 * Represents a single value for an attribute, including optional documentation.
 * This is used to store enumerated values for attributes in a structured way.
 */
export class AttributeValue {
  value: string;
  documentation?: string;

  constructor(value: string, documentation?: string) {
    this.value = value;
    this.documentation = documentation;
  }
}

/**
 * Represents a collection of possible values for an attribute, including documentation.
 * This is used to store enumerated values for attributes in a structured way.
 */
export class AttributeValuesItem {
  parentName: string;
  values: AttributeValue[];

  constructor(parentName: string = '', values: AttributeValue[] = []) {
    this.parentName = parentName;
    this.values = values;
  }
}

export class ElementParent {
  name: string;
  isGroup: boolean;

  constructor(name: string, isGroup: boolean = false) {
    this.name = name;
    this.isGroup = isGroup;
  }
}

/**
 * Represents a single, fully-resolved XSD schema with all includes merged.
 */
class Schema {
  /**
   * Regular expression to match XPath items.
   */
  private static readonly xPathItemRegex = /(xs:[a-zA-Z0-9]+)(?:\[@name="([^"]+)"\])?/;
  /**
   * Set of node types that do not contain elements.
   */
  private static readonly nodesWithoutElements: Set<string> = new Set([
    'xs:annotation',
    'xs:documentation',
    'xs:import',
    'xs:include',
    'xs:attributeGroup',
    'xs:attribute',
    'xs:restriction',
  ]);
  /**
   * Set of node types that do not contain groups.
   */
  private static readonly nodesWithoutGroups: Set<string> = new Set([
    'xs:annotation',
    'xs:documentation',
    'xs:import',
    'xs:include',
    'xs:attributeGroup',
    'xs:attribute',
    'xs:restriction',
  ]);
  private rootSchema: any;
  private elementCache = new Map<string, any[]>();
  private simpleTypeCache = new Map<string, any | null>();
  private complexTypeCache = new Map<string, any | null>();
  private groupCache = new Map<string, any | null>();
  private elementsInGroupsCache = new Map<string, Set<string>>();
  private typesToParentsCache = new Map<string, ElementParent[]>();
  private groupsToParentsCache = new Map<string, ElementParent[]>();
  private attributeGroupCache = new Map<string, any | null>();
  private allAttributesCache = new Map<string, any[][]>();
  private allAttributesMapCache = new Map<string, AttributeOfElement[]>();
  private attributeValuesCache = new Map<string, AttributeValuesItem[]>();
  private missingAttributesCache = new Map<string, any[]>();
  private childElementsCache = new Map<string, any[]>();
  private attributesByTypesCache = new Map<string, string[]>();

  constructor(schema: any) {
    this.rootSchema = schema;
    this.preCacheSchema();
    logger.info('Schema pre-caching completed.'); /*
    this.collectParentsForGroups();
    logger.info('Collecting parents for groups completed.'); */
    this.groupCache.forEach((group, name) => {
      logger.info(`Enriching group: ${name}`);
      this.enrichGroups(group, name, new Set([name]), name);
      logger.info(`Enriched group: ${name}`);
    });
    this.enrichTypesViaExtensions();
    logger.info('Enriching types via extensions completed.');
    // this.complexTypeCache.forEach((type, name) => {
    //   logger.info(`Collecting elements from complex type: ${name}`);
    //   this.collectParentsFromType(type, 'xs:complexType', name);
    // });
    this.collectParentsForTypes();
    logger.info('Collecting parents from types completed.');
    this.enrichElementsFromTypes();
    logger.info('Enriching elements from types completed.');
    this.enrichElementsByParents();
    logger.info('Enriching elements by parents completed.');
    let withParents = 0;
    let withoutParents = 0;
    for (const [name, elements] of this.elementCache) {
      for (let i = 0; i < elements.length; i++) {
        if (elements[i]['parents'] && elements[i]['parents'].length > 0) {
          withParents++;
        } else {
          logger.info(`Element "${name}" has no parents, xPath: ${elements[i].$.xPath}`);
          withoutParents++;
        }
      }
    }
    logger.info('Schema initialized and pre-cached successfully.');
  }

  /**
   * Pre-caches the schema by traversing it and storing elements, types, and groups in their respective caches.
   * This allows for quick lookups later without needing to traverse the schema again.
   * @param node The current node being processed, starting with the root schema.
   * @param xPath The current XPath for the node, used for referencing elements.
   * @param nodeType The type of the current node (e.g., 'xs:element', 'xs:simpleType').
   * @param nodeType The type of the current node (e.g., 'xs:element', 'xs:simpleType').
   */
  private preCacheSchema(node: any = this.rootSchema, xPath: string = '', nodeType: string = ''): void {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      let i = 0;
      for (const item of node) {
        this.preCacheSchema(item, `${xPath}[${item.$ ? '@name="' + item.$.name + '"' : i}]`, nodeType);
        i++;
      }
    } else {
      if (node.$ && node.$.name) {
        node.$.xPath = xPath;
        const name = node.$.name;
        if (nodeType === 'xs:element') {
          if (!this.elementCache.has(name)) {
            this.elementCache.set(name, []);
          }
          const elements = this.elementCache.get(name);
          if (elements) {
            elements.push(node);
          }
        } else if (nodeType === 'xs:simpleType') {
          this.simpleTypeCache.set(name, node);
        } else if (nodeType === 'xs:complexType') {
          this.complexTypeCache.set(name, node);
        } else if (nodeType === 'xs:attributeGroup') {
          this.attributeGroupCache.set(name, node);
        } else if (nodeType === 'xs:group') {
          this.groupCache.set(name, node);
        }
      }
      for (const key in node) {
        const newXPath = `${xPath}/${key}`;
        if (key !== '$' && typeof node[key] === 'object') {
          this.preCacheSchema(
            node[key],
            newXPath + (node[key].$ && node[key].$.name ? '[@name="' + node[key].$.name + '"]' : ''),
            key
          );
        }
      }
    }
  }

  /**
   * Enriches elements from complex types by merging their definitions into the elements.
   * This allows elements to inherit properties from their complex type definitions.
   */
  private enrichElementsFromTypes(): void {
    // Apply types to elements based on their definitions
    for (const [name, elements] of this.elementCache) {
      const elementsLength = elements.length;
      for (let i = 0; i < elementsLength; i++) {
        let element = elements.shift();
        const typeDef = this.complexTypeCache.get(element.$.type);
        if (typeDef) {
          const newElement = { ...element, ...typeDef };
          if (newElement.$) {
            newElement.$ = { ...newElement.$, ...element.$ };
          }
          element = newElement; // Update the element reference
        } else if (
          element['xs:complexType'] &&
          element['xs:complexType']['xs:complexContent'] &&
          element['xs:complexType']['xs:complexContent']['xs:extension']
        ) {
          const extension = element['xs:complexType']['xs:complexContent']['xs:extension'];
          element['xs:complexType']['xs:complexContent'] = undefined;
          const extensionName = extension.$.base;
          const baseTypeDef = this.complexTypeCache.get(extensionName);
          if (baseTypeDef) {
            // Merge base type properties into the current element
            for (const key in baseTypeDef) {
              if (key !== '$' && key !== 'xs:annotation') {
                element[key] = baseTypeDef[key];
              }
            }
            for (const key in extension) {
              if (key !== '$' && key !== 'xs:annotation') {
                if (element[key] === undefined) {
                  element[key] = extension[key];
                } else if (Array.isArray(element[key]) && Array.isArray(extension[key])) {
                  element[key] = element[key].concat(extension[key]);
                } else if (typeof element[key] === 'object' && typeof extension[key] === 'object') {
                  element[key] = [element[key], extension[key]];
                } else {
                  logger.warn(`Unexpected merge case for key "${key}" in type "${name}"`);
                }
              }
            }
            if (!this.typesToParentsCache.has(extensionName)) {
              this.typesToParentsCache.set(extensionName, []);
            }
            const typeElements = this.typesToParentsCache.get(extensionName);
            if (typeElements) {
              typeElements.push(new ElementParent(name));
            }
          }
        }
        elements.push(element);
      }
    }
  }

  private enrichTypesViaExtensions(): void {
    // Enrich complex types by applying extensions from their definitions
    for (const name of this.complexTypeCache.keys()) {
      let type = this.complexTypeCache.get(name);
      if (type['xs:complexContent'] && type['xs:complexContent']['xs:extension']) {
        const extension = type['xs:complexContent']['xs:extension'];
        const baseTypeDef = this.complexTypeCache.get(extension.$.base);
        if (baseTypeDef) {
          // Merge base type properties into the current type
          const newType = structuredClone(baseTypeDef);
          newType.$.extended = newType.$.name || '';
          newType.$.name = name; // Update the name to the current type
          this.complexTypeCache.set(name, newType);
          type = this.complexTypeCache.get(name);
          for (const key in extension) {
            if (key !== '$') {
              if (type[key] === undefined) {
                type[key] = extension[key];
              } else if (Array.isArray(type[key]) && Array.isArray(extension[key])) {
                type[key] = type[key].concat(extension[key]);
              } else if (typeof type[key] === 'object' && typeof extension[key] === 'object') {
                type[key] = [type[key], extension[key]];
              } else {
                logger.warn(`Unexpected merge case for key "${key}" in type "${name}"`);
              }
            }
          }
        }
      }
    }
  }

  private collectParentsForTypes(): void {
    // Collect parent elements for each type in the schema
    const elements = Array.from(this.elementCache.keys());
    for (const [name, type] of this.complexTypeCache) {
      const filtered = elements.filter(
        (el) => this.elementCache.has(el) && this.elementCache.get(el).find((e) => e.$.type === name)
      );
      if (filtered.length > 0) {
        if (!this.typesToParentsCache.has(name)) {
          this.typesToParentsCache.set(name, []);
        }
        const typeElements = this.typesToParentsCache.get(name);
        if (typeElements) {
          for (const el of filtered) {
            typeElements.push(new ElementParent(el));
          }
        }
      }
    }
  }

  private collectParentsForGroups(): void {
    // for (const [name, elements] of this.elementCache) {
    //   for (const element of elements) {
    //     this.checkForGroupsForParent(element, 'xs:element', name, false);
    //   }
    // }
    for (const [name, group] of this.groupCache) {
      this.checkForGroupsForParent(group, 'xs:group', name, true);
    }
  }

  private checkForGroupsForParent(node: any, nodeName: string, parentName: string, isGroup: boolean): void {
    if (!node || typeof node !== 'object') return;

    if (nodeName === 'xs:group' && node.$ && node.$.ref) {
      if (this.groupsToParentsCache.has(node.$.ref) === false) {
        this.groupsToParentsCache.set(node.$.ref, []);
      }
      const groupElements = this.groupsToParentsCache.get(node.$.ref);
      if (groupElements) {
        groupElements.push(new ElementParent(parentName, isGroup));
      }
      return;
    }

    for (const key in node) {
      if (key !== '$' && Schema.nodesWithoutGroups.has(key) === false && typeof node[key] === 'object') {
        if (Array.isArray(node[key])) {
          for (let i = 0; i < node[key].length; i++) {
            this.checkForGroupsForParent(node[key][i], key, parentName, isGroup);
          }
        } else {
          this.checkForGroupsForParent(node[key], key, parentName, isGroup);
        }
      }
    }
    return;
  }

  // /**
  //  * Collects parent elements for each type in the schema.
  //  * This allows elements to reference their parent types and groups.
  //  * @param node The current node being processed.
  //  * @param nodeType The type of the current node (e.g., 'xs:element', 'xs:group').
  //  * @param typeName The name of the type being processed.
  //  */
  // private collectParentsFromType(node: any, nodeType: string, typeName: string): void {
  //   if (!node || typeof node !== 'object') return;

  //   if (nodeType === 'xs:element' && node.$ && node.$.name) {
  //     if (!this.typesToParentsCache.has(typeName)) {
  //       this.typesToParentsCache.set(typeName, []);
  //     }
  //     const typeElements = this.typesToParentsCache.get(typeName);
  //     if (typeElements) {
  //       typeElements.push(new ElementParent(node.$.name));
  //     }
  //     return; // Stop processing further for elements
  //   } else if (nodeType === 'xs:group' && node.$ && node.$.ref) {
  //     if (!this.typesToParentsCache.has(typeName)) {
  //       this.typesToParentsCache.set(typeName, []);
  //     }
  //     const typeElements = this.typesToParentsCache.get(typeName);
  //     if (typeElements) {
  //       typeElements.push(new ElementParent(node.$.ref, true));
  //     }
  //     return; // Stop processing further for groups
  //   }

  //   for (const key in node) {
  //     if (key !== '$' && !Schema.nodesWithoutElements.has(key) && typeof node[key] === 'object') {
  //       if (Array.isArray(node[key])) {
  //         for (let i = 0; i < node[key].length; i++) {
  //           this.collectParentsFromType(node[key][i], key, typeName);
  //         }
  //       } else {
  //         this.collectParentsFromType(node[key], key, typeName);
  //       }
  //     }
  //   }
  // }

  /**
   * Enriches elements by applying parent references based on their XPath.
   * This allows elements to reference their parent elements or groups.
   */
  private enrichElementsByParents(): void {
    // Apply parent references to elements
    const complexTypes = Array.from(this.complexTypeCache.keys());
    const extendedFromTypes = Array.from(this.complexTypeCache.values()).map((type) => type.$.extended || '');
    for (const [name, elements] of this.elementCache) {
      for (const element of elements) {
        const xPathItems = (element.$.xPath || '').split('/');
        xPathItems.pop();
        for (let j = xPathItems.length - 1; j >= 0; j--) {
          const item = xPathItems[j];
          const match = item.match(Schema.xPathItemRegex);
          if (match && match[1] && match[2]) {
            const nodeType = match[1];
            const nodeName = match[2] || '';
            if (nodeType === 'xs:element' && nodeName) {
              if (element['parents'] === undefined) {
                element['parents'] = [];
              }
              element['parents'].push(new ElementParent(nodeName));
              break; // Stop at the first element type
            } else if (nodeType === 'xs:group' && nodeName) {
              if (element['parents'] === undefined) {
                element['parents'] = [];
              }
              element['parents'].push(new ElementParent(nodeName, true));
              break; // Stop at the first group type
            } else if (nodeType === 'xs:complexType' && nodeName) {
              let parentsFromType = this.typesToParentsCache.get(nodeName);
              if (!parentsFromType) {
                const extendedFromTypeIndex = extendedFromTypes.indexOf(nodeName);
                if (extendedFromTypeIndex >= 0) {
                  parentsFromType = this.typesToParentsCache.get(complexTypes[extendedFromTypeIndex]);
                }
              }
              if (!parentsFromType || parentsFromType.length === 0) continue;
              if (element['parents'] === undefined) {
                element['parents'] = [];
              }
              for (const parentElement of parentsFromType) {
                element['parents'].push(parentElement);
              }
              break; // Stop at the first complexType
            }
          }
        }
      }
    }
  }

  /**
   * Enriches groups by applying references and collecting elements within groups.
   * This allows groups to reference other groups and collect elements defined within them.
   * @param group The group object to enrich.
   * @param nodeType The type of the node (e.g., 'xs:group', 'xs:element').
   * @param appliedReferences A set of already applied references to avoid circular references.
   * @param topGroupName The name of the top-level group being processed.
   * @return The enriched group object.
   */
  private enrichGroups(group: any, nodeType: string, appliedReferences: Set<string>, topGroupName: string): any {
    if (!group || typeof group !== 'object') return undefined;

    if (nodeType === 'xs:group' && group.$ && group.$.ref) {
      if (!appliedReferences.has(group.$.ref)) {
        const refGroup = this.groupCache.get(group.$.ref);
        if (refGroup) {
          logger.info(
            `Applying group reference: ${group.$.ref}. Previously applied references: ${Array.from(appliedReferences).join(', ')}`
          );
          appliedReferences.add(group.$.ref);
          group = { ...refGroup };
        }
      }
    } else if (nodeType === 'xs:element') {
      if (group.$ && group.$.name) {
        if (!this.elementsInGroupsCache.has(topGroupName)) {
          this.elementsInGroupsCache.set(topGroupName, new Set());
        }
        const elementsSet = this.elementsInGroupsCache.get(topGroupName);
        if (elementsSet) {
          elementsSet.add(group.$.name);
        }
      }
    }
    for (const key in group) {
      if (key !== '$' && !Schema.nodesWithoutGroups.has(key) && typeof group[key] === 'object') {
        if (Array.isArray(group[key])) {
          for (let i = 0; i < group[key].length; i++) {
            if (key === 'xs:group' && group[key][i] && group[key][i].$.enriched) continue; // Skip already enriched nodes
            group[key][i] = this.enrichGroups(group[key][i], key, appliedReferences, topGroupName);
          }
        } else {
          if (key === 'xs:group' && group[key].$.enriched) continue; // Skip already enriched nodes
          group[key] = this.enrichGroups(group[key], key, appliedReferences, topGroupName);
        }
      }
    }
    if (nodeType === 'xs:group' && group.$ && group.$.name) {
      group.$.enriched = true; // Mark the group as enriched
    }
    return group;
  }

  /**
   * Finds all definitions for an element by name within this schema.
   * @param elementName The name of the element to find.
   * @returns An array of element definitions.
   */
  public findElementDefinition(elementName: string, parentName: string = ''): any[] {
    if (!this.rootSchema || !this.elementCache.has(elementName)) {
      this.elementCache.set(elementName, []);
      return [];
    }
    const elementDefinitions = this.elementCache.get(elementName);
    if (elementDefinitions.length === 0) {
      return [];
    }
    const definitions: any[] = [];
    for (const element of elementDefinitions) {
      const parents = element['parents'] || [];
      if (parents.length === 0) {
        if (parentName === '') {
          definitions.push({ ...element, parentName: '' });
        }
        continue;
      }
      if (parentName !== '') {
        if (
          parents.find(
            (parent: ElementParent) => parent.isGroup === false && parent.name === parentName /* ||
              (parent.isGroup === true &&
                this.elementsInGroupsCache.has(parent.name) &&
                this.elementsInGroupsCache.get(parent.name).has(parentName)) */
          ) !== undefined
        ) {
          definitions.push({ ...element, parentName: parentName });
        }
      }
    }
    return definitions;
  }

  /**
   * Recursively searches for all element definitions within a schema node.
   */
  private findNestedElementDefinitions(
    node: any,
    elementName: string,
    visited: Set<any>,
    definitions: any[],
    parentElement?: any,
    xPath: string = ''
  ): void {
    if (!node || typeof node !== 'object' || visited.has(xPath)) {
      return;
    }
    visited.add(xPath);
    // logger.info(`Searching for element "${elementName}" at path: ${xPath}`);
    if (Array.isArray(node)) {
      let i = 0;
      for (const item of node) {
        this.findNestedElementDefinitions(
          item,
          elementName,
          visited,
          definitions,
          parentElement,
          `${xPath}[${item.$ ? 'name="' + item.$.name + '"' : i}]`
        );
        i++;
      }
    } else {
      for (const key in node) {
        const newXPath = `${xPath}/${key}`;
        if (key === 'xs:element') {
          const elementIsArray = Array.isArray(node[key]);
          const elements = elementIsArray ? node[key] : [node[key]];
          for (const el of elements) {
            const elementXPath = elementIsArray ? `${newXPath}[name="${el.$.name}"]` : newXPath;
            const typeDef = el.$ && el.$.type ? this.findTypeDefinition(el.$.type) : undefined;
            if (el.$ && el.$.name === elementName) {
              const newDef = typeDef ? { ...typeDef, ...el } : { ...el };
              if (parentElement?.$?.name) {
                newDef.parentName = parentElement.$.name;
              }
              definitions.push(newDef);
            }
            // Recurse into the element definition, passing it as the new parent.
            this.findNestedElementDefinitions(el, elementName, visited, definitions, el, elementXPath);

            // Handle type attribute to find nested elements within types
            if (typeDef) {
              this.findNestedElementDefinitions(
                typeDef,
                elementName,
                visited,
                definitions,
                el,
                `/xs:schema/${typeDef.$.typeName}[name="${typeDef.$.name}"]`
              );
            }
          }
        } else if (key !== '$' && typeof node[key] === 'object' && Schema.nodesWithoutElements.has(key) === false) {
          this.findNestedElementDefinitions(node[key], elementName, visited, definitions, parentElement, newXPath);
        }
      }
    }
  }

  /**
   * Finds a type definition (simpleType or complexType) by name.
   */
  public findTypeDefinition(typeName: string): any | undefined {
    if (this.simpleTypeCache.has(typeName)) {
      const result = this.simpleTypeCache.get(typeName);
      return result === null ? undefined : result;
    }
    if (!this.rootSchema || !this.rootSchema['xs:schema']) {
      this.simpleTypeCache.set(typeName, null);
      return undefined;
    }
    const schemaRoot = this.rootSchema['xs:schema'];

    const simpleTypes = schemaRoot['xs:simpleType']
      ? Array.isArray(schemaRoot['xs:simpleType'])
        ? schemaRoot['xs:simpleType']
        : [schemaRoot['xs:simpleType']]
      : [];
    for (const type of simpleTypes) {
      if (type?.$?.name === typeName) {
        type.$.typeName = 'xs:simpleType';
        this.simpleTypeCache.set(typeName, type);
        return type;
      }
    }

    const complexTypes = schemaRoot['xs:complexType']
      ? Array.isArray(schemaRoot['xs:complexType'])
        ? schemaRoot['xs:complexType']
        : [schemaRoot['xs:complexType']]
      : [];
    for (const type of complexTypes) {
      if (type?.$?.name === typeName) {
        type.$.typeName = 'xs:complexType';
        this.simpleTypeCache.set(typeName, type);
        return type;
      }
    }
    this.simpleTypeCache.set(typeName, null);
    return undefined;
  }

  /**
   * Finds an attribute group definition by name.
   */
  public findAttributeGroupDefinition(groupName: string): any {
    if (this.attributeGroupCache.has(groupName)) {
      const cached = this.attributeGroupCache.get(groupName);
      return cached === null ? undefined : cached;
    }
    if (!this.rootSchema || !this.rootSchema['xs:schema']) {
      this.attributeGroupCache.set(groupName, null);
      return undefined;
    }
    const schemaRoot = this.rootSchema['xs:schema'];

    const attributeGroups = schemaRoot['xs:attributeGroup']
      ? Array.isArray(schemaRoot['xs:attributeGroup'])
        ? schemaRoot['xs:attributeGroup']
        : [schemaRoot['xs:attributeGroup']]
      : [];
    for (const group of attributeGroups) {
      if (group?.$?.name === groupName) {
        this.attributeGroupCache.set(groupName, group);
        return group;
      }
    }
    this.attributeGroupCache.set(groupName, null);
    return undefined;
  }

  /**
   * Recursively collects all attributes for a given element definition or complex type.
   */
  private collectAttributes(definition: any, collectedAttributes: Map<string, any>): void {
    if (!definition) return;

    const attributes = definition['xs:attribute']
      ? Array.isArray(definition['xs:attribute'])
        ? definition['xs:attribute']
        : [definition['xs:attribute']]
      : [];
    for (const attr of attributes) {
      if (attr?.$?.name && !collectedAttributes.has(attr.$.name)) {
        collectedAttributes.set(attr.$.name, attr);
      }
    }

    const attributeGroups = definition['xs:attributeGroup']
      ? Array.isArray(definition['xs:attributeGroup'])
        ? definition['xs:attributeGroup']
        : [definition['xs:attributeGroup']]
      : [];
    for (const groupRef of attributeGroups) {
      if (groupRef?.$?.ref) {
        const groupDef = this.findAttributeGroupDefinition(groupRef.$.ref);
        if (groupDef) {
          this.collectAttributes(groupDef, collectedAttributes);
        }
      }
    }

    const complexContent = definition['xs:complexContent'];
    if (complexContent?.['xs:extension']) {
      const extension = complexContent['xs:extension'];
      this.collectAttributes(extension, collectedAttributes);
      if (extension?.$?.base) {
        const baseTypeDef = this.findTypeDefinition(extension.$.base);
        if (baseTypeDef) {
          this.collectAttributes(baseTypeDef, collectedAttributes);
        }
      }
    }
  }

  /**
   * Gets all possible attributes for a given element.
   */
  public getAllPossibleAttributes(elementName: string, parentName: string = ''): any[] {
    if (this.allAttributesCache.has(elementName)) {
      return this.allAttributesCache.get(elementName)!;
    }
    const elementDefs = this.findElementDefinition(elementName, parentName);
    if (elementDefs.length === 0) {
      this.allAttributesCache.set(elementName, []);
      return [];
    }

    const allPossibleAttributes: any[] = [];

    for (const elementDef of elementDefs) {
      const collectedAttributes = new Map<string, any>();
      this.collectAttributes(elementDef, collectedAttributes);

      if (elementDef?.$?.type) {
        const typeDef = this.findTypeDefinition(elementDef.$.type);
        if (typeDef) {
          this.collectAttributes(typeDef, collectedAttributes);
        }
      }

      if (elementDef['xs:complexType']) {
        this.collectAttributes(elementDef['xs:complexType'], collectedAttributes);
      }

      const result = { parentName: elementDef.parentName, attributes: Array.from(collectedAttributes.values()) };
      for (const attr of result.attributes) {
        if (attr?.$?.type) {
          const typeDef = this.findTypeDefinition(attr.$.type);
          if (typeDef?.['xs:restriction']?.$?.base) {
            attr.$.restriction = typeDef['xs:restriction'].$.base;
          }
        }
      }
      allPossibleAttributes.push(result);
    }
    this.allAttributesCache.set(elementName, allPossibleAttributes);
    return allPossibleAttributes;
  }

  /**
   * Gets all possible attributes for a given element, returning an array of maps for each definition variant.
   */
  public getAllPossibleAttributesMap(elementName: string, parentName: string): AttributeOfElement[] {
    if (this.allAttributesMapCache.has(elementName)) {
      return this.allAttributesMapCache.get(elementName)!;
    }
    const attributeVariations = this.getAllPossibleAttributes(elementName, parentName);
    const resultVariations: AttributeOfElement[] = [];

    for (const attributesRecord of attributeVariations) {
      const newRecord = new AttributeOfElement(attributesRecord.parentName);
      for (const attr of attributesRecord.attributes) {
        if (!attr || !attr.$ || !attr.$.name) continue;
        const newAttr = {};
        for (const key of Object.keys(attr)) {
          if (key !== '$' && key !== 'xs:annotation') {
            newAttr[key] = attr[key];
          } else if (key === '$') {
            for (const subKey of Object.keys(attr.$)) {
              if (subKey !== 'name') {
                newAttr[subKey] = attr.$[subKey];
              }
            }
          } else if (key === 'xs:annotation') {
            if (attr['xs:annotation']?.['xs:documentation']) {
              const docNode = attr['xs:annotation']['xs:documentation'];
              newAttr['documentation'] = typeof docNode === 'string' ? docNode : docNode?._ || '';
            }
          }
        }
        newRecord.attributes.set(attr.$.name, newAttr);
      }
      resultVariations.push(newRecord);
    }
    this.allAttributesMapCache.set(elementName, resultVariations);
    return resultVariations;
  }

  /**
   * Gets possible enumeration values for a specific attribute of an element.
   */
  public getAttributePossibleValues(elementName: string, attributeName: string): AttributeValuesItem[] {
    const cacheKey = `${elementName}|${attributeName}`;
    if (this.attributeValuesCache.has(cacheKey)) {
      return this.attributeValuesCache.get(cacheKey)!;
    }
    const attributeVariations = this.getAllPossibleAttributes(elementName);
    if (attributeVariations.length === 0) {
      this.attributeValuesCache.set(cacheKey, []);
      return [];
    }

    const result: AttributeValuesItem[] = [];

    for (const attributesRecord of attributeVariations) {
      const resultItem = new AttributeValuesItem(attributesRecord.parentName);
      const attribute = attributesRecord.attributes.find((a: any) => a?.$?.name === attributeName);
      if (attribute) {
        const typeDef = this.findTypeDefinition(attribute.$.type);
        if (!typeDef) {
          this.attributeValuesCache.set(cacheKey, []);
          return [];
        }

        const processRestriction = (restriction: any) => {
          if (!restriction) return;
          const enumerations = restriction['xs:enumeration']
            ? Array.isArray(restriction['xs:enumeration'])
              ? restriction['xs:enumeration']
              : [restriction['xs:enumeration']]
            : [];
          for (const enumValue of enumerations) {
            let doc = '';
            if (enumValue['xs:annotation']?.['xs:documentation']) {
              const docNode = enumValue['xs:annotation']['xs:documentation'];
              doc = typeof docNode === 'string' ? docNode : docNode?._ || '';
            }
            if (enumValue?.$?.value) {
              resultItem.values.push(new AttributeValue(enumValue.$.value, doc.trim()));
            }
          }
        };

        if (typeDef['xs:restriction']) {
          processRestriction(typeDef['xs:restriction']);
        } else if (typeDef['xs:union']) {
          const memberTypes = typeDef['xs:union']?.$?.memberTypes?.split(' ') || [];
          for (const memberTypeName of memberTypes) {
            const memberTypeDef = this.findTypeDefinition(memberTypeName);
            if (memberTypeDef?.['xs:restriction']) {
              processRestriction(memberTypeDef['xs:restriction']);
            }
          }
        }
      }
      result.push(resultItem);
    }
    this.attributeValuesCache.set(cacheKey, result);
    return result;
  }

  /**
   * Gets a list of mandatory attributes that are missing from an element.
   */
  // public getMissingMandatoryAttributes(elementName: string, existingAttributeNames: string[]): any[] {
  //   const cacheKey = `${elementName}|${[...existingAttributeNames].sort().join(',')}`;
  //   if (this.missingAttributesCache.has(cacheKey)) {
  //     return this.missingAttributesCache.get(cacheKey)!;
  //   }
  //   const allAttributeVariations = this.getAllPossibleAttributes(elementName);
  //   const existingSet = new Set(existingAttributeNames);
  //   // For simplicity, we check against the first variation.
  //   // A more sophisticated approach might be needed depending on desired behavior.
  //   const allAttributes = allAttributeVariations.length > 0 ? allAttributeVariations[0] : [];
  //   const result = allAttributes.filter((attr) => attr?.$?.use === 'required' && !existingSet.has(attr?.$?.name));
  //   this.missingAttributesCache.set(cacheKey, result);
  //   return result;
  // }

  /**
   * Recursively collects all possible child elements from a definition.
   */
  private collectChildElements(definition: any, collectedElements: Map<string, any>): void {
    if (!definition) return;

    const processGroup = (group: any) => {
      if (!group) return;
      const elements = group['xs:element']
        ? Array.isArray(group['xs:element'])
          ? group['xs:element']
          : [group['xs:element']]
        : [];
      for (const el of elements) {
        const name = el?.$?.name || el?.$?.ref;
        if (name && !collectedElements.has(name)) {
          collectedElements.set(name, el);
        }
      }

      ['xs:sequence', 'xs:choice', 'xs:all'].forEach((container) => {
        if (group[container]) {
          const items = Array.isArray(group[container]) ? group[container] : [group[container]];
          items.forEach((item) => processGroup(item));
        }
      });
    };

    ['xs:sequence', 'xs:choice', 'xs:all'].forEach((container) => {
      if (definition[container]) {
        processGroup(definition[container]);
      }
    });

    const complexContent = definition['xs:complexContent'];
    if (complexContent?.['xs:extension']) {
      const extension = complexContent['xs:extension'];
      this.collectChildElements(extension, collectedElements);
      if (extension?.$?.base) {
        const baseTypeDef = this.findTypeDefinition(extension.$.base);
        if (baseTypeDef) {
          this.collectChildElements(baseTypeDef, collectedElements);
        }
      }
    }
  }

  /**
   * Gets a list of possible child elements for a given element.
   */
  public getPossibleChildElements(elementName: string): any[] {
    if (this.childElementsCache.has(elementName)) {
      return this.childElementsCache.get(elementName)!;
    }
    const elementDefs = this.findElementDefinition(elementName);
    if (elementDefs.length === 0) {
      this.childElementsCache.set(elementName, []);
      return [];
    }

    const collectedElements = new Map<string, any>();
    for (const elementDef of elementDefs) {
      if (elementDef['xs:complexType']) {
        this.collectChildElements(elementDef['xs:complexType'], collectedElements);
      }
      if (elementDef?.$?.type) {
        const typeDef = this.findTypeDefinition(elementDef.$.type);
        if (typeDef) {
          this.collectChildElements(typeDef, collectedElements);
        }
      }
    }
    const result = Array.from(collectedElements.values());
    this.childElementsCache.set(elementName, result);
    return result;
  }

  /**
   * Gets attribute names for an element that match a list of types.
   */
  //   public elementAttributesByTypes(elementName: string, types: string[]): string[] {
  //     const cacheKey = `${elementName}|${[...types].sort().join(',')}`;
  //     if (this.attributesByTypesCache.has(cacheKey)) {
  //       return this.attributesByTypesCache.get(cacheKey)!;
  //     }
  //     const allAttributesVariations = this.getAllPossibleAttributes(elementName);
  //     if (allAttributesVariations.length === 0) {
  //       this.attributesByTypesCache.set(cacheKey, []);
  //       return [];
  //     }
  //     const allAttributes = allAttributesVariations[0];
  //     const typeSet = new Set(types);
  //     const result: string[] = [];
  //     for (const attr of allAttributes) {
  //       if (attr?.$?.type && typeSet.has(attr.$.type)) {
  //         result.push(attr.$.name);
  //       }
  //     }
  //     this.attributesByTypesCache.set(cacheKey, result);
  //     return result;
  //   }
}

/**
 * Manages loading and accessing different XSD schema contexts.
 */
export class XsdReference {
  private schemas: Map<string, Schema> = new Map();
  private schemaPaths: Map<string, string>;

  constructor(schemaPaths: Map<string, string>) {
    this.schemaPaths = schemaPaths;
  }

  public async initialize(): Promise<void> {
    for (const [scriptType, schemaPath] of this.schemaPaths.entries()) {
      try {
        const schemaRoot = await this.loadAndParseSchema(schemaPath);
        if (schemaRoot) {
          this.schemas.set(scriptType, new Schema(schemaRoot));
          logger.info(`Successfully initialized schema for ${scriptType}`);
        }
      } catch (error) {
        logger.error(`Failed to initialize schema for ${scriptType} from ${schemaPath}: ${error}`);
      }
    }
  }

  private async loadAndParseSchema(schemaPath: string): Promise<any> {
    logger.info(`Loading XSD schema: ${schemaPath}`);
    const xsdContent = await fs.promises.readFile(schemaPath, 'utf8');

    const parser = new xml2js.Parser({
      explicitCharkey: true,
      explicitArray: false,
      mergeAttrs: false,
      normalizeTags: false,
      attrNameProcessors: [(name) => name.split(':').pop() || name],
    });

    const result = await parser.parseStringPromise(xsdContent);
    await this.processIncludes(result, schemaPath, new Set([path.resolve(schemaPath)]));

    return result;
  }

  private async processIncludes(schema: any, basePath: string, loadedPaths: Set<string>): Promise<void> {
    if (!schema?.['xs:schema']?.['xs:include']) {
      return;
    }
    const includes = schema['xs:schema']['xs:include'];
    const includeArray = Array.isArray(includes) ? includes : [includes];

    for (const include of includeArray) {
      if (include?.$?.schemaLocation) {
        const includePath = path.resolve(path.dirname(basePath), include.$.schemaLocation);
        if (loadedPaths.has(includePath)) {
          continue;
        }
        loadedPaths.add(includePath);
        logger.info(`Processing included schema: ${include.$.schemaLocation}`);
        await this.loadIncludedSchema(includePath, schema, loadedPaths);
      }
    }
  }

  private async loadIncludedSchema(includePath: string, parentSchema: any, loadedPaths: Set<string>): Promise<void> {
    try {
      const xsdBaseName = path.basename(includePath);
      let includedSchema;
      if (this.schemas.has(xsdBaseName)) {
        includedSchema = this.schemas.get(xsdBaseName);
      } else {
        const xsdContent = await fs.promises.readFile(includePath, 'utf8');
        const parser = new xml2js.Parser({
          explicitCharkey: true,
          explicitArray: false,
          mergeAttrs: false,
          normalizeTags: false,
          attrNameProcessors: [(name) => name.split(':').pop() || name],
        });
        includedSchema = await parser.parseStringPromise(xsdContent);
        // this.schemas.set(xsdBaseName, includedSchema);
      }
      if (!includedSchema || !includedSchema['xs:schema']) {
        logger.warn(`Included schema at ${includePath} is empty or invalid.`);
        return;
      }
      this.mergeSchemas(parentSchema, includedSchema);
      await this.processIncludes(includedSchema, includePath, loadedPaths);
    } catch (error) {
      logger.error(`Error loading included schema ${includePath}: ${error}`);
    }
  }

  private mergeSchemas(parentSchema: any, includedSchema: any): void {
    const parentRoot = parentSchema?.['xs:schema'];
    const includedRoot = includedSchema?.['xs:schema'];
    if (!parentRoot || !includedRoot) return;

    const elementsToMerge = [
      'xs:simpleType',
      'xs:complexType',
      'xs:element',
      'xs:attribute',
      'xs:attributeGroup',
      'xs:group',
    ];
    for (const elementType of elementsToMerge) {
      if (includedRoot[elementType]) {
        if (!parentRoot[elementType]) {
          parentRoot[elementType] = [];
        } else if (!Array.isArray(parentRoot[elementType])) {
          parentRoot[elementType] = [parentRoot[elementType]];
        }
        const includedElements = Array.isArray(includedRoot[elementType])
          ? includedRoot[elementType]
          : [includedRoot[elementType]];
        parentRoot[elementType].push(...includedElements);
      }
    }
  }

  public getSchema(scriptType: string): Schema | undefined {
    return this.schemas.get(scriptType);
  }

  public findElementDefinition(scriptType: string, elementName: string): any[] {
    return this.getSchema(scriptType)?.findElementDefinition(elementName) ?? [];
  }

  public getAllPossibleAttributes(
    scriptType: string,
    elementName: string,
    parentName: string = '',
    attributes: string[] = []
  ): AttributeOfElement[] {
    const result = this.getSchema(scriptType)?.getAllPossibleAttributesMap(elementName, parentName) ?? [];
    if (result.length === 0) {
      return [];
    } else if (result.length === 1) {
      return result;
    } else {
      const filtered = result.filter((def) => def.parentName === '' || def.parentName === parentName);
      if (attributes.length > 0 && filtered.length > 1) {
        const commonAttributes = filtered
          .map((def) => ({
            count: attributes.reduce((acc: number, attr) => {
              if (def.attributes.has(attr)) {
                acc++;
              }
              return acc;
            }, 0),
            parentName: def.parentName,
            attributes: def.attributes,
          }))
          .sort((a, b) => b.count - a.count);
        const maxCommon = commonAttributes[0].count;
        if (maxCommon === 0) {
          return filtered;
        }
        return commonAttributes
          .filter((item) => item.count === maxCommon)
          .map((item) => new AttributeOfElement(item.parentName, item.attributes));
      } else {
        return filtered;
      }
    }
  }

  public getAttributePossibleValues(
    scriptType: string,
    elementName: string,
    attributeName: string,
    parentName: string = ''
  ): AttributeValuesItem[] {
    const result = this.getSchema(scriptType)?.getAttributePossibleValues(elementName, attributeName) ?? [];
    return result.length > 1
      ? result.filter((item) => item.parentName === '' || item.parentName === parentName)
      : result;
  }

  // public getMissingMandatoryAttributes(
  //   scriptType: string,
  //   elementName: string,
  //   existingAttributeNames: string[]
  // ): any[] {
  //   return this.getSchema(scriptType)?.getMissingMandatoryAttributes(elementName, existingAttributeNames) ?? [];
  // }

  public getPossibleChildElements(scriptType: string, elementName: string): any[] {
    return this.getSchema(scriptType)?.getPossibleChildElements(elementName) ?? [];
  }

  // public elementAttributesByTypes(scriptType: string, elementName: string, types: string[]): string[] {
  //   return this.getSchema(scriptType)?.elementAttributesByTypes(elementName, types) ?? [];
  // }
}
