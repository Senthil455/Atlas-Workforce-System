package com.atlas.common.security;

import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.context.annotation.ComponentScan;

@AutoConfiguration
@ComponentScan(basePackageClasses = { InternalAuthFilter.class, RoleAspect.class })
public class CommonSecurityAutoConfiguration {
}
